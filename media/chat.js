/* Talking to a chat from inside the logbook.

   The finished conversation is drawn by main.js from the transcript, as it
   always was - Claude, started in the background by the extension, keeps
   writing the same file. This file adds the parts a transcript cannot show:
   a box to type into, the reply while it is still being written, and the
   approvals and questions Claude is waiting on.

   Loaded after main.js and sharing its globals ($, el, send, icon, CUR,
   SESSIONS, PENDING_CHAT, FOLLOW, stickToEnd). Everything that came from
   Claude or a transcript is drawn with textContent or md(), which escapes. */

const CHAT = {
  reading: new Map(),    // chat id -> pictures still being read, kept with the chat, not the box
  sendWhenRead: new Set(), // chats whose Enter waits for those pictures
  tipSeen: true,         // the one-time "you can reply here" tip, until the host says otherwise
  sentLog: new Map(),    // chat id -> messages sent from here, oldest first: Up brings them back
  shell: new Map(),      // chat id -> "!" commands run here: { key, cmd, out, running, code, sentWith }
  where: new Map(),      // chat id -> { where, at }: where a chat running elsewhere runs
  cutoff: new Set(),     // chats whose last reply a window reload cut off
  state: new Map(),      // chat id -> what the host says about its Claude here
  drafts: new Map(),     // chat id -> unsent text
  images: new Map(),     // chat id -> pasted pictures waiting to go
  echo: new Map(),       // chat id -> messages sent but not yet in the transcript, oldest first
  partial: new Map(),    // chat id -> the reply being written
  landed: new Set(),     // chats whose half-written reply is now in the transcript
  notes: new Map(),      // chat id -> { err, text } shown under the conversation
  picks: new Map(),      // chat id -> { model, mode, effort } chosen here
  done: new Map(),       // chat id -> when the last reply finished, and how long it took
  here: new Map(),       // new chats started in the logbook: id -> { copyOf, folder }
  commands: [],          // slash commands, as the last Claude to start listed them
  models: [],
  busySince: new Map(),  // chat id -> when it last started working
  taskOut: new Map(),    // "chat id|task id" -> { output, truncated } of a background task you opened
  side: new Map(),       // chat id -> side questions (/btw) and their answers
  mcp: new Map(),        // chat id -> its MCP servers, once asked with /mcp
  editor: { label: '', file: '' },   // what the editor has open, which goes with your message
  skipCtx: new Set(),    // chats whose next message goes without the editor's file
  files: new Map(),      // chat id -> attached PDFs and text files waiting to go
  thoughtOpen: new Set(), // chats whose live thinking you opened
  stopping: new Set(),   // "chat id|task id": Stop pressed, until the task goes
  todosFold: new Map(),  // chat id -> true/false: you folded or opened its to-do list (a finished one folds by itself)
}
let COMPOSER = null

const MODES = [
  ['default', 'Ask first', 'Claude asks before editing files or running commands'],
  ['acceptEdits', 'Accept edits', 'File edits go through; commands still ask'],
  ['plan', 'Plan first', 'Claude plans and asks you to approve before changing anything'],
  ['auto', 'Auto mode', 'Claude decides what is safe to run without asking'],
]
// asks nothing at all: offered only once "Skip permission prompts" is on in Settings
const BYPASS = ['bypassPermissions', 'Bypass permissions', 'Claude runs everything without asking']
const modes = () => CFG.skipPermissions ? [...MODES, BYPASS] : MODES
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FALLBACK_MODELS = [
  { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' },
]
const MAX_IMAGE = 5 * 1024 * 1024

/** The Settings switch: off keeps the logbook read-only, the way it was. */
const chatOn = () => CFG.chatHere !== false

/** The chat the panel is showing, when it is one you can talk to here. */
function chatTarget () {
  const d = $('#detail')
  if (!d || d.hidden) return null
  if (CUR) {
    if (CUR.isAgent || CUR.provider === 'codex') return null
    return { id: CUR.id }
  }
  if (PENDING_CHAT && CHAT.here.has(PENDING_CHAT)) return { id: PENDING_CHAT, pending: true }
  return null
}

const picksFor = id => {
  if (!CHAT.picks.has(id)) {
    // start on the model the chat was last using: left on "default", carrying
    // on here could quietly switch a chat you had moved to another model
    let was = CUR?.id === id ? String(CUR.info?.model || '') : ''
    // the transcript names the model without its [1m]; a chat on the big
    // window has to keep it, or carrying on here would shrink its context
    if (was && CUR.info?.window >= 1e6 && !/\[1m\]$/i.test(was)) was += '[1m]'
    CHAT.picks.set(id, { model: /^[\w.[\]-]{1,60}$/.test(was) ? was : '', mode: CFG.chatPermissionMode || 'default', effort: CFG.chatEffort || '' })
  }
  return CHAT.picks.get(id)
}

/** Running here, running somewhere else, or not running at all. */
function whereRunning (id) {
  const st = CHAT.state.get(id)
  // not known yet, or just stopped here and still listed as running for a moment
  if (!st || Date.now() - (st.endedAt || 0) < 10000) return st?.running ? 'here' : ''
  if (st.running) return 'here'
  const row = SESSIONS.find(x => x.id === id)
  return row?.live ? 'elsewhere' : ''
}

/**
 * Put the box at the bottom of the chat. main.js rebuilds the chat view from
 * scratch now and then, so the same box is carried over rather than rebuilt,
 * keeping what you were typing and where the cursor was.
 */
function chatMount () {
  if (BOARD_MODE) return
  if (!chatOn()) {
    // the mode, status and live area were moved out of the box: they go too
    if (COMPOSER) { for (const n of [COMPOSER.root, COMPOSER.live, COMPOSER.mode, COMPOSER.status]) n.remove(); COMPOSER = null }
    return
  }
  const t = chatTarget()
  if (!t) return
  const d = $('#detail')
  const fresh = !COMPOSER || COMPOSER.id !== t.id
  if (fresh) {
    COMPOSER = buildComposer(t.id)
    send({ type: 'chatState', id: t.id })
    send({ type: 'chatEditorAsk' })
  }
  const focused = document.activeElement === COMPOSER.ta
  // right under the conversation, at the top of the footer: the chat's numbers
  // and changed files sit below it, and the "Claude is working" strip, which
  // floats just above the footer, floats above the box rather than over it
  const foot = d.querySelector(':scope > .foot')
  const host = foot || d
  const before = foot ? [...foot.children].find(n => !n.classList.contains('runstrip') && n !== COMPOSER.root) || null : null
  if (COMPOSER.root.parentNode !== host || COMPOSER.root.nextSibling !== before) host.insertBefore(COMPOSER.root, before)
  if (focused && document.activeElement !== COMPOSER.ta) COMPOSER.ta.focus()
  placeStatusLine(foot)
  if (t.pending) pendingIntro(t.id)
  placeLive()
  paintComposer()
}

function setMode (c, value) {
  picksFor(c.id).mode = value
  c.mode.value = value
  send({ type: 'chatMode', id: c.id, value })
  // and every new chat after it - except bypass, which is picked chat by chat
  if (value !== 'bypassPermissions') setCfg('chatPermissionMode', value)
}
/** Shift+Tab in the box steps through the modes, as it does in Claude Code's terminal. */
function cycleMode (c) {
  const list = modes()
  const i = list.findIndex(m => m[0] === picksFor(c.id).mode)
  setMode(c, list[(i + 1) % list.length][0])
}

/** The mode and status join the "Claude" numbers under the box; a new chat has none yet, so they get their own line. */
function placeStatusLine (foot) {
  const host = foot?.querySelector('.fgroup') || COMPOSER.root
  for (const n of [COMPOSER.mode, COMPOSER.status]) if (n.parentNode !== host) host.appendChild(n)
}

/** A new chat started here says so, in place of the "started in a terminal" note. */
function pendingIntro (id) {
  const d = $('#detail')
  const info = CHAT.here.get(id) || {}
  const h2 = d.querySelector('.dtop h2')
  if (h2) h2.textContent = info.copyOf ? `Copy of ${info.copyOf}` : 'New chat'
  const wait = d.querySelector('.pendingchat')
  if (wait) {
    const sent = !!CHAT.echo.get(id)?.length || CHAT.partial.has(id)
    wait.replaceChildren(el('span', '', sent ? ''
      : info.copyOf ? 'A copy of that chat, with all of its context. Type below to carry on here.'
        : `A new chat${info.folder && info.folder !== '~' ? ` in ${info.folder}` : ''}. Type your first message below.`))
    wait.hidden = sent
  }
  // the pending view has no message list of its own to stream into
  if (!d.querySelector('.msgs')) {
    const stage = el('div', 'stage')
    stage.appendChild(el('div', 'msgs'))
    d.insertBefore(stage, COMPOSER.root.parentNode === d ? COMPOSER.root : null)
  }
}

// ------------------------------------------------------------ the live area

/** What is happening now, kept as the last thing in the conversation. */
function placeLive () {
  const body = $('#detail .msgs')
  if (!body || !COMPOSER) return
  paintLive()
  if (body.lastElementChild !== COMPOSER.live) body.appendChild(COMPOSER.live)
  if (FOLLOW) stickToEnd(body)
}

/** "12s · Esc to stop" while a reply runs; the clock starts when the chat turned busy. */
function elapsed (id) {
  const st = CHAT.state.get(id)
  const at = CHAT.busySince.get(id)
  const tool = CHAT.partial.get(id)?.toolSecs
  const r = st?.retry
  const wait = r && r.at > Date.now() ? ` · next try in ${Math.ceil((r.at - Date.now()) / 1000)}s` : ''
  return (at ? `${secs(Date.now() - at)}` : '') + wait + (tool ? ` · this step ${tool}s` : '') + ' · Esc to stop'
}
setInterval(() => {
  const e = COMPOSER && document.querySelector('.chatworking .chatel')
  if (e) e.textContent = elapsed(COMPOSER.id)
}, 1000)

function paintLive () {
  if (!COMPOSER) return
  const id = COMPOSER.id
  const live = COMPOSER.live
  live.replaceChildren()
  const st = CHAT.state.get(id)
  // what you sent sits above the reply to it; a message queued behind that
  // reply waits below it, as typed-ahead input does in Claude Code's terminal
  const echoes = CHAT.echo.get(id) || []
  const isQueued = e => e.queued && st?.busy
  const drawEcho = echo => {
    const queued = isQueued(echo)
    const w = el('div', 'msg user chatecho' + (queued ? ' queued' : ''))
    if (echo.text) w.appendChild(el('div', 'bubble', echo.text))
    const meta = [queued ? 'Queued: Claude reads this when it finishes' : '',
      echo.images ? `${echo.images} image${echo.images === 1 ? '' : 's'} attached` : '',
      echo.files ? `${echo.files} file${echo.files === 1 ? '' : 's'} attached` : ''].filter(Boolean).join(' · ')
    if (meta || (queued && echo.uuid)) {
      const m = el('div', 'chatmeta', meta)
      // a queued message can still be taken back, and comes back into the box
      if (queued && echo.uuid) {
        const x = el('button', 'linkbtn', 'Take back')
        x.title = 'Claude will not read it; the text goes back in the box'
        x.onclick = () => { x.disabled = true; send({ type: 'chatCancelQueued', id, uuid: echo.uuid }) }
        m.append(' · ', x)
      }
      w.appendChild(m)
    }
    live.appendChild(w)
  }
  // "!" commands: what ran, its output, and whether Claude has seen it yet
  for (const sh of CHAT.shell.get(id) || []) {
    const w = el('div', 'chatshell' + (sh.running ? ' running' : sh.code ? ' failed' : ''))
    const head = el('div', 'shhead')
    head.append(el('code', 'shcmd', '! ' + sh.cmd))
    if (sh.running) {
      const stop = el('button', 'btn', 'Stop')
      stop.onclick = () => send({ type: 'chatShellStop', id, key: sh.key })
      head.appendChild(stop)
    }
    w.appendChild(head)
    if (sh.out) {
      const pre = el('pre', 'shout', sh.out.length > 20000 ? '…' + sh.out.slice(-20000) : sh.out)
      w.appendChild(pre)
      // follows new output unless you scrolled up in it
      pre.onscroll = () => { sh.top = pre.scrollHeight - pre.scrollTop - pre.clientHeight > 8 ? pre.scrollTop : null }
      requestAnimationFrame(() => { pre.scrollTop = sh.top ?? pre.scrollHeight })
    }
    w.appendChild(el('div', 'chatmeta', sh.running ? 'Running in the chat\'s folder…'
      : `${sh.code ? `Exited with code ${sh.code}` : 'Done'} · ${sh.sentWith ? 'sent to Claude with your message' : 'Claude sees this with your next message'}`))
    live.appendChild(w)
  }
  echoes.filter(e => !isQueued(e)).forEach(drawEcho)
  const p = CHAT.partial.get(id)
  if (p?.text) {
    const w = el('div', 'msg assistant chatstream')
    const b = el('div', 'bubble')
    b.innerHTML = window.md(p.text)
    w.appendChild(b)
    live.appendChild(w)
  }
  // Claude's to-do list, while it is working through one
  const todos = st?.todos || []
  if (todos.length) live.appendChild(todoList(id, todos, !!st?.busy))
  // the one status line, as Claude Code's terminal has: what it is doing, for how long
  if ((st?.asks || []).length) {
    const line = el('div', 'chatworking wait')
    line.append(el('span', 'chatwaitdot'), el('span', '', 'Waiting for you: answer below'))
    live.appendChild(line)
  } else if (st?.busy) {
    const line = el('div', 'chatworking')
    line.append(el('span', 'chatdots'), el('span', '',
      busyWord(st, p)),
    el('span', 'chatel', elapsed(id)))
    live.appendChild(line)
    // what a sub-agent is doing, so its work does not look frozen
    if (p?.agent) live.appendChild(el('div', 'chatagent', `Agent · ${p.agent}`))
    // the thinking as it happens, folded unless you open it
    if (p?.thought) {
      const d = document.createElement('details')
      d.className = 'chatthought'
      d.open = CHAT.thoughtOpen.has(id)
      d.ontoggle = () => { if (d.open) CHAT.thoughtOpen.add(id); else CHAT.thoughtOpen.delete(id) }
      d.append(el('summary', '', 'Thinking'), el('div', 'chatthinktext', p.thought))
      live.appendChild(d)
    }
  } else if (st?.status === 'compacting') {
    const line = el('div', 'chatworking')
    line.append(el('span', 'chatdots'), el('span', '', 'Compacting the conversation…'))
    live.appendChild(line)
  } else if (st?.bg?.length) {
    // the reply is done, but agents or commands it started are still going:
    // Claude picks their results up by itself when they finish
    const n = st.bg.length
    const line = el('div', 'chatworking')
    line.append(el('span', 'chatdots'), el('span', '',
      `Waiting for ${n} background ${n === 1 ? 'task' : 'tasks'}. Claude picks up the results when they finish`))
    live.appendChild(line)
  }
  // agents and commands running in the background, working or not: each can be looked at or stopped
  for (const t of st?.bg || []) live.appendChild(bgTask(id, t))
  echoes.filter(isQueued).forEach(drawEcho)
  // side questions: answered beside the chat, never part of it
  for (const q of CHAT.side.get(id) || []) {
    const w = el('div', 'chatside')
    const head = el('div', 'shhead')
    head.append(el('span', 'bgkind', 'Side question'), el('span', 'shcmd', q.q))
    const x = el('button', 'iconbtn', '×')
    x.title = 'Dismiss'
    x.onclick = () => { CHAT.side.set(id, (CHAT.side.get(id) || []).filter(o => o !== q)); paintLive() }
    head.appendChild(x)
    w.appendChild(head)
    const a = el('div', 'bubble')
    if (q.a === null) a.textContent = 'Thinking…'
    else if (q.a === false) a.textContent = 'No answer came back.'
    else a.textContent = q.a
    w.appendChild(a)
    live.appendChild(w)
  }
  const servers = CHAT.mcp.get(id)
  if (servers) {
    const w = el('div', 'chatside')
    const head = el('div', 'shhead')
    head.append(el('span', 'bgkind', 'MCP servers'), el('span', 'shcmd', ''))
    const x = el('button', 'iconbtn', '×')
    x.onclick = () => { CHAT.mcp.delete(id); paintLive() }
    head.appendChild(x)
    w.appendChild(head)
    if (servers === 'loading') w.appendChild(el('div', 'chatmeta', 'Asking Claude…'))
    else if (servers === 'unavailable') w.appendChild(el('div', 'chatmeta', 'Claude did not answer. Try /mcp again.'))
    else if (!servers.length) w.appendChild(el('div', 'chatmeta', 'This chat has no MCP servers.'))
    else for (const v of servers) {
      const row = el('div', 'mcprow ' + (v.status === 'connected' ? 'ok' : v.status === 'failed' ? 'bad' : ''))
      row.append(el('span', 'mcpdot'), el('b', '', v.name), el('span', 'chatmeta', v.status))
      w.appendChild(row)
    }
    live.appendChild(w)
  }
  const note = CHAT.notes.get(id)
  if (note) {
    const n = el('div', 'chatnote' + (note.err ? ' err' : ''))
    n.appendChild(el('span', '', note.text))
    if (note.action) {
      const b = el('button', 'btn', note.action.label)
      b.onclick = () => send({ ...note.action.msg, id })
      n.appendChild(b)
    }
    const x = el('button', 'iconbtn', '×')
    x.title = 'Dismiss'
    x.onclick = () => { CHAT.notes.delete(id); paintLive() }
    n.appendChild(x)
    live.appendChild(n)
  }
  live.hidden = !live.children.length
}

/** The to-do list: what is done, what Claude is on, what is left. A finished list folds to one line. */
function todoList (id, todos, busy) {
  const done = todos.filter(t => t.status === 'completed').length
  const finished = done === todos.length
  const w = el('div', 'chattodos')
  const head = el('button', 'tdhead')
  const open = !(CHAT.todosFold.get(id) ?? finished)
  head.append(el('span', 'tdtitle', 'To-do'), el('span', 'chatmeta', `${done} of ${todos.length} done`))
  head.title = open ? 'Fold the list' : 'Show the list'
  head.setAttribute('aria-expanded', String(open))
  head.onclick = () => { CHAT.todosFold.set(id, open); paintLive() }
  w.appendChild(head)
  if (!open) return w
  const ul = el('ul', 'tdlist')
  for (const t of todos) {
    const li = el('li', 'td ' + t.status)
    li.append(el('span', 'tdmark', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'),
      el('span', '', t.status === 'in_progress' && busy && t.doing ? t.doing : t.text))
    ul.appendChild(li)
  }
  w.appendChild(ul)
  return w
}

/** One background agent or command: what it is, its output on request, and a way to stop it. */
function bgTask (id, t) {
  const key = id + '|' + t.id
  const w = el('div', 'chatshell running bgtask')
  const head = el('div', 'shhead')
  const kind = /bash|shell/i.test(t.kind) ? 'Command' : /agent/i.test(t.kind) ? 'Agent' : 'Task'
  head.append(el('span', 'bgkind', kind), el('span', 'shcmd', t.what || 'Running in the background'))
  const out = CHAT.taskOut.get(key)
  const look = el('button', 'btn', out ? 'Hide output' : 'Output')
  look.onclick = () => {
    if (CHAT.taskOut.has(key)) { CHAT.taskOut.delete(key); paintLive(); return }
    CHAT.taskOut.set(key, { output: '', truncated: false, loading: true })
    send({ type: 'chatTaskOutput', id, taskId: t.id })
    paintLive()
  }
  const stopping = CHAT.stopping.has(key)
  const stop = el('button', 'btn', stopping ? 'Stopping…' : 'Stop')
  stop.disabled = stopping
  stop.title = 'Stops just this one. The reply and anything else running carry on'
  stop.onclick = () => { CHAT.stopping.add(key); send({ type: 'chatTaskStop', id, taskId: t.id }); paintLive() }
  head.append(look, stop)
  w.appendChild(head)
  // what an agent is on right now, and how far it has got
  if (t.now || t.steps) w.appendChild(el('div', 'chatmeta bgnow', [t.now, t.steps ? `${t.steps} step${t.steps === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')))
  if (out) {
    const agent = /agent/i.test(t.kind)
    const text = out.loading && !out.output ? 'Loading…' : out.output ||
      (out.failed ? (agent ? 'Nothing recorded yet: the agent is just starting.' : 'Its output could not be read.') : agent ? 'No steps yet.' : 'Nothing printed yet.')
    const pre = el('pre', 'shout', (out.truncated ? '…' : '') + (text.length > 20000 ? '…' + text.slice(-20000) : text))
    w.appendChild(pre)
    pre.onscroll = () => { out.top = pre.scrollHeight - pre.scrollTop - pre.clientHeight > 8 ? pre.scrollTop : null }
    requestAnimationFrame(() => { pre.scrollTop = out.top ?? pre.scrollHeight })
  }
  return w
}
// an open output follows along while the task runs
setInterval(() => {
  if (!COMPOSER || document.hidden) return
  const bg = CHAT.state.get(COMPOSER.id)?.bg || []
  for (const t of bg) if (CHAT.taskOut.has(COMPOSER.id + '|' + t.id)) send({ type: 'chatTaskOutput', id: COMPOSER.id, taskId: t.id })
}, 2000)

/** A message that did not go (taken back, or refused): its words, pictures and files back in the box. */
function giveBack (id, e) {
  if (e.text) {
    const now = CHAT.drafts.get(id) || ''
    CHAT.drafts.set(id, now.trim() ? `${e.text}\n${now}` : e.text)
  }
  if (e.pics?.length) CHAT.images.set(id, [...e.pics, ...(CHAT.images.get(id) || [])])
  if (e.docs?.length) CHAT.files.set(id, [...e.docs, ...(CHAT.files.get(id) || [])])
  // left out of the editor's file before: still left out when it is sent again
  if (e.noContext) CHAT.skipCtx.add(id)
  if (COMPOSER?.id === id) { COMPOSER.ta.value = CHAT.drafts.get(id) || ''; COMPOSER.fit(); paintImages(COMPOSER); paintGo(COMPOSER) }
}

const FALLBACK_WHY = {
  model_not_found: 'the model you picked is not available',
  permission_denied: 'your account cannot use the model you picked',
  overloaded: 'the model you picked is busy right now',
}

/** The status line's words: what Claude is doing right now, as exactly as it says. */
function busyWord (st, p) {
  if (st?.status === 'compacting') return 'Compacting the conversation…'
  if (st?.retry) return `Retrying after an error${st.retry.why ? ` (${st.retry.why})` : ''}, try ${st.retry.attempt}${st.retry.max ? ` of ${st.retry.max}` : ''}…`
  if (st?.hooks) return 'Running your hooks…'
  if (p?.tool && !p.text) return `Running ${toolWord(p.tool)}${p.detail ? `: ${p.detail}` : ''}…`
  if (p?.thinking) return p.thinkTokens ? `Thinking · ${p.thinkTokens >= 1000 ? (p.thinkTokens / 1000).toFixed(1) + 'k' : p.thinkTokens} tokens…` : 'Thinking…'
  return p?.text ? 'Writing…' : 'Working…'
}

const toolWord = t => ({ Bash: 'a command', Read: 'a file read', Edit: 'an edit', Write: 'a write', Grep: 'a search', Glob: 'a file search', Task: 'an agent', Agent: 'an agent', WebFetch: 'a web fetch', WebSearch: 'a web search' }[t] || t)

// ------------------------------------------------------------ the box

function buildComposer (id) {
  const root = el('div', 'composer')
  const asks = el('div', 'casks')
  const imgs = el('div', 'cimgs')
  const block = el('div', 'cblock')
  const ta = el('textarea', 'cinput')
  ta.rows = 1
  ta.value = CHAT.drafts.get(id) || ''
  const slash = el('div', 'cslash')
  slash.hidden = true
  const bar = el('div', 'cbar')
  // the box holds only the text and the send button. The mode and the reply's
  // status sit with the chat's numbers below it, the way Claude Code's own
  // status line does; model and effort are changed with /model and /effort
  const mode = el('select', 'cpick cmode')
  mode.title = 'What Claude may do without asking (Shift+Tab in the box to switch). New chats start on the last one you picked'
  const status = el('span', 'cstatus')
  const go = el('button', 'cgo')
  // attach a picture, a PDF or a text file
  const clip = el('button', 'cattach')
  clip.appendChild(icon('plus'))
  clip.title = 'Attach a picture, PDF or text file (or paste or drop one in)'
  const pickFile = document.createElement('input')
  pickFile.type = 'file'; pickFile.multiple = true; pickFile.hidden = true
  pickFile.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,' + TEXT_EXT.map(x => '.' + x).join(',')
  clip.onclick = () => pickFile.click()
  bar.append(clip, pickFile, go)
  // what the editor has open goes with the message: said here, and can be left out
  const ctxLine = el('div', 'cctx')
  const live = el('div', 'chatlive')
  // the text and its pickers share one box, the way a chat app's input reads
  const box = el('div', 'cbox')
  box.append(imgs, ta, bar)
  box.onclick = e => { if (e.target === box || e.target === bar) ta.focus() }
  // once, the first time anyone sees the box: what it is and where to turn it off
  const tip = el('div', 'ctip')
  root.append(asks, block, tip, ctxLine, box, slash)
  const c = { id, root, asks, imgs, block, tip, ta, slash, bar, mode, status, go, live, slashAt: 0, ctxLine, mention: null }
  pickFile.onchange = () => { for (const f of pickFile.files) addAny(c, f); pickFile.value = '' }

  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px' }
  c.fit = fit
  ta.oninput = () => { CHAT.drafts.set(id, ta.value); fit(); askMention(c); paintSlash(c); paintGo(c) }
  ta.onkeydown = e => {
    if (!c.slash.hidden && slashKey(c, e)) return
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(c); return }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing &&
      recall(c, e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(c) }
    else if (e.key === 'Escape' && !e.isComposing) {
      // like the terminal: Escape stops a reply in progress
      if (CHAT.state.get(id)?.busy) { e.preventDefault(); send({ type: 'chatStop', id }) }
      else ta.blur()
    }
  }
  ta.onblur = () => setTimeout(() => { c.slash.hidden = true }, 150)
  ta.onpaste = e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault()
    files.forEach(f => addAny(c, f))
  }
  root.ondragover = e => { if ([...(e.dataTransfer?.items || [])].some(i => i.kind === 'file')) e.preventDefault() }
  root.ondrop = e => {
    const files = [...(e.dataTransfer?.files || [])]
    if (!files.length) return
    e.preventDefault()
    files.forEach(f => addAny(c, f))
  }
  go.onclick = () => {
    const st = CHAT.state.get(id)
    if (st?.busy && !ta.value.trim() && !(CHAT.images.get(id) || []).length && !(CHAT.files.get(id) || []).length) send({ type: 'chatStop', id })
    else submit(c)
  }
  mode.onchange = () => setMode(c, mode.value)
  requestAnimationFrame(fit)
  return c
}

// text files Claude can read as they are, by extension when the type is not given
const TEXT_EXT = 'txt md csv tsv json yaml yml xml html css js ts jsx tsx py rb go rs java kt swift c h cpp cs php sh sql log diff patch toml ini env conf'.split(' ')
const MAX_PDF = 18 * 1024 * 1024        // the host takes up to 25 MB of base64, about 18.7 MB
const MAX_TEXT = 390 * 1024
/** A picture goes as a picture; a PDF or a text file is attached by name. */
function addAny (c, file) {
  if (file.type.startsWith('image/')) return addImage(c, file)
  const ext = (/\.([\w]+)$/.exec(file.name) || [])[1]?.toLowerCase() || ''
  const pdf = file.type === 'application/pdf' || ext === 'pdf'
  const text = !pdf && (file.type.startsWith('text/') || /json|xml|yaml|javascript|sql/.test(file.type) || TEXT_EXT.includes(ext))
  if (!pdf && !text) { note(c.id, `${file.name} can't be attached: only pictures, PDFs and text files can.`, true); return }
  if (file.size > (pdf ? MAX_PDF : MAX_TEXT)) { note(c.id, `${file.name} is too big to attach (${pdf ? '18 MB' : '390 KB'} at most).`, true); return }
  const id = c.id
  const r = new FileReader()
  CHAT.reading.set(id, (CHAT.reading.get(id) || 0) + 1)
  const done = () => {
    const left = (CHAT.reading.get(id) || 1) - 1
    if (left) CHAT.reading.set(id, left); else CHAT.reading.delete(id)
    if (!left && CHAT.sendWhenRead.delete(id) && COMPOSER?.id === id) submit(COMPOSER)
  }
  r.onerror = () => { note(id, `${file.name} could not be read.`, true); done() }
  r.onload = () => {
    const item = { name: file.name, mediaType: pdf ? 'application/pdf' : 'text/plain' }
    if (pdf) item.data = String(r.result).replace(/^data:[^,]*,/, '')
    else item.text = String(r.result)
    CHAT.files.set(id, [...(CHAT.files.get(id) || []), item].slice(0, 8))
    if (COMPOSER?.id === id) { paintImages(COMPOSER); paintGo(COMPOSER) }
    done()
  }
  if (pdf) r.readAsDataURL(file); else r.readAsText(file)
}

function addImage (c, file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { note(c.id, 'Only PNG, JPEG, GIF and WebP pictures can be sent.', true); return }
  if (file.size > MAX_IMAGE) { note(c.id, 'That picture is over 5 MB.', true); return }
  const r = new FileReader()
  const id = c.id
  CHAT.reading.set(id, (CHAT.reading.get(id) || 0) + 1)
  const done = () => {
    const left = (CHAT.reading.get(id) || 1) - 1
    if (left) CHAT.reading.set(id, left); else CHAT.reading.delete(id)
    // the box may have been rebuilt since (you switched chats and back): send from the current one
    if (!left && CHAT.sendWhenRead.delete(id) && COMPOSER?.id === id) submit(COMPOSER)
  }
  r.onerror = () => { note(c.id, 'That picture could not be read.', true); done() }
  r.onload = () => {
    const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(r.result))
    if (!m) { done(); return }
    const list = CHAT.images.get(c.id) || []
    list.push({ mediaType: m[1], data: m[2], url: String(r.result) })
    CHAT.images.set(c.id, list.slice(0, 8))
    paintImages(c)
    paintGo(c)
    done()
  }
  r.readAsDataURL(file)
}

function paintImages (c) {
  const list = CHAT.images.get(c.id) || []
  c.imgs.replaceChildren()
  list.forEach((im, i) => {
    const chip = el('div', 'cimg')
    const img = el('img')
    img.src = im.url
    img.alt = 'Pasted picture'
    const x = el('button', 'cimgx', '×')
    x.title = 'Remove'
    x.onclick = () => { list.splice(i, 1); paintImages(c); paintGo(c) }
    chip.append(img, x)
    c.imgs.appendChild(chip)
  })
  const files = CHAT.files.get(c.id) || []
  files.forEach((f, i) => {
    const chip = el('div', 'cfile')
    chip.append(el('span', 'cfileext', f.mediaType === 'application/pdf' ? 'PDF' : 'TXT'), el('span', 'cfilename', f.name))
    chip.title = f.name
    const x = el('button', 'cimgx', '×')
    x.title = 'Remove'
    x.onclick = () => { files.splice(i, 1); paintImages(c); paintGo(c) }
    chip.appendChild(x)
    c.imgs.appendChild(chip)
  })
  c.imgs.hidden = !list.length && !files.length
}

/** The line above the box: which file goes with the message, and a way to leave it out. */
function paintCtx (c) {
  const e = CHAT.editor
  c.ctxLine.replaceChildren()
  const show = CFG.chatEditorContext !== false && !!e.label && whereRunning(c.id) !== 'elsewhere'
  c.ctxLine.hidden = !show
  if (!show) return
  const skip = CHAT.skipCtx.has(c.id)
  const name = el('span', 'cctxname' + (skip ? ' off' : ''), e.label)
  name.title = e.file
  c.ctxLine.append(el('span', '', skip ? 'Not sending' : 'Claude sees'), name)
  const t = el('button', 'linkbtn', skip ? 'Send it' : 'Leave out')
  t.title = skip ? 'Send what you have open with your next message' : 'Send your next message without it'
  t.onclick = () => { if (!CHAT.skipCtx.delete(c.id)) CHAT.skipCtx.add(c.id); paintCtx(c) }
  c.ctxLine.appendChild(t)
}

// ------------------------------------------------------------ @ mentions

/** "@" then a few letters: files in the chat's folder to pick from. */
let MENTION_SOON = null
function askMention (c) {
  // a "!" line runs in a shell: a file name dropped into it unquoted could run as code
  if (/^\s*!/.test(c.ta.value)) { c.mention = null; return }
  const before = c.ta.value.slice(0, c.ta.selectionStart)
  const m = /(?:^|\s)@([\w./-]*)$/.exec(before)
  if (!m) { c.mention = null; return }
  const q = m[1]
  const at = before.length - q.length - 1
  // the same letters typed somewhere else in the box: the list stays, the place moves
  if (c.mention?.q === q) { c.mention.at = at; return }
  c.mention = { q, list: c.mention?.list || [], at }
  clearTimeout(MENTION_SOON)
  MENTION_SOON = setTimeout(() => send({ type: 'chatFiles', id: c.id, q }), 120)
}
function pickMention (c, x) {
  const at = c.mention.at
  const end = c.ta.selectionStart
  c.ta.value = c.ta.value.slice(0, at) + '@' + x.name + ' ' + c.ta.value.slice(end)
  const pos = at + x.name.length + 2
  c.ta.setSelectionRange(pos, pos)
  c.mention = null
  CHAT.drafts.set(c.id, c.ta.value)
  c.slash.hidden = true
  c.ta.focus()
  paintGo(c)
}

function submit (c, only) {
  const id = c.id
  // a picture pasted a moment ago may still be loading: send once it is in.
  // A message of the logbook's own (only) is sent as it is, draft untouched
  if (!only && CHAT.reading.get(id)) { CHAT.sendWhenRead.add(id); return }
  const text = only ? only.text : c.ta.value
  const images = only ? [] : CHAT.images.get(id) || []
  const files = only ? [] : CHAT.files.get(id) || []
  if (!text.trim() && !images.length && !files.length) return
  if (images.length > 8 || files.length > 8) { note(id, 'A message can carry at most 8 pictures and 8 files. Remove some, then send.', true); return }
  if (!images.length && !files.length && localCommand(c, text)) return
  if (whereRunning(id) === 'elsewhere') return
  // "!" runs a command in the chat's folder, as in Claude Code's terminal: Claude
  // does not answer it, but gets the command and its output with your next message
  if (!images.length && /^\s*!/.test(text)) {
    const cmd = text.replace(/^\s*!/, '').trim()
    if (!cmd) return
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    CHAT.shell.set(id, [...(CHAT.shell.get(id) || []), { key, cmd, out: '', running: true, code: null }])
    CHAT.sentLog.set(id, [...(CHAT.sentLog.get(id) || []), text].slice(-50))
    send({ type: 'chatShell', id, key, cmd })
    c.ta.value = ''
    c.fit()
    c.slash.hidden = true
    FOLLOW = true
    placeLive()
    paintComposer()
    return
  }
  const p = picksFor(id)
  CHAT.cutoff.delete(id)
  CHAT.sentLog.set(id, [...(CHAT.sentLog.get(id) || []), text].slice(-50))
  tipDone()                              // the first message says you found it
  c.hist = null
  // finished commands go to Claude with this message; they leave the view once it lands
  for (const sh of CHAT.shell.get(id) || []) if (!sh.running && !sh.sentWith) { sh.sentWith = text; sh.sentAt = Date.now() }
  // the message's own id: a queued one can be taken back by it
  const uuid = crypto.randomUUID ? crypto.randomUUID() : (() => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  })()
  const noContext = CHAT.skipCtx.delete(id)
  send({ type: 'chatSend', id, uuid, text, images: images.map(im => ({ mediaType: im.mediaType, data: im.data })), files, noContext, model: p.model, mode: p.mode, effort: p.effort })
  const queued = !!CHAT.state.get(id)?.busy
  CHAT.echo.set(id, [...(CHAT.echo.get(id) || []), { text, uuid, images: images.length, files: files.length, pics: images, docs: files, noContext, at: Date.now(), queued }])
  CHAT.notes.delete(id)
  CHAT.done.delete(id)
  const st = CHAT.state.get(id) || { id, asks: [] }
  if (!st.busy) CHAT.busySince.set(id, Date.now())
  CHAT.state.set(id, { ...st, busy: true })
  if (!only) {
    CHAT.drafts.delete(id)
    CHAT.images.delete(id)
    CHAT.files.delete(id)
    c.ta.value = ''
    c.fit()
    c.slash.hidden = true
    paintImages(c)
  }
  FOLLOW = true
  if (CHAT.here.has(id)) pendingIntro(id)
  placeLive()
  paintComposer()
}

/**
 * Up and Down in the box walk through what you sent in this chat, newest first,
 * as Claude Code's terminal does - so a message you stopped comes straight back
 * to edit. Only from an empty box, or while already walking, and only from the
 * first line (Up) or last line (Down), so moving through a long draft still works.
 */
function recall (c, dir) {
  const ta = c.ta
  const walking = c.hist && ta.value === c.hist.list[c.hist.at]
  if (!walking && ta.value.trim()) return false
  const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd)
  if (walking && dir < 0 && before.includes('\n')) return false
  if (walking && dir > 0 && after.includes('\n')) return false
  if (!walking) {
    if (dir > 0) return false
    // what this chat has from you: its transcript, plus anything sent since
    // a "!" command from the transcript is not offered: only one typed here may run
    const mine = (CUR?.id === c.id ? CUR.turns || [] : []).filter(t => t.role === 'user' && t.text).map(t => String(t.text))
      .filter(t => !/^\s*!/.test(t))
    for (const s of CHAT.sentLog.get(c.id) || []) if (!mine.slice(-5).includes(s)) mine.push(s)
    const list = mine.filter((s, i) => s.trim() && s !== mine[i - 1])
    if (!list.length) return false
    c.hist = { list, at: list.length, draft: ta.value }
  }
  const at = c.hist.at + dir
  if (at < 0) return true                                    // the oldest: stay there
  c.hist.at = at
  ta.value = at >= c.hist.list.length ? c.hist.draft : c.hist.list[at]
  if (at >= c.hist.list.length) c.hist = null                // back past the newest: your draft
  CHAT.drafts.set(c.id, ta.value)
  c.fit()
  paintGo(c)
  const end = ta.value.length
  ta.setSelectionRange(end, end)
  return true
}

function note (id, text, err, action) {
  CHAT.notes.set(id, { text, err, action })
  if (COMPOSER?.id === id) placeLive()
}

function paintComposer () {
  const c = COMPOSER
  if (!c) return
  const id = c.id
  const where = whereRunning(id)
  // two Claudes writing one chat would tangle it: one running elsewhere is
  // continued as a copy instead
  const blocked = where === 'elsewhere'
  c.block.replaceChildren()
  c.block.hidden = !blocked
  c.ta.parentNode.hidden = blocked
  if (blocked && CHAT.state.get(id)?.orphan) {
    // started here before the window reloaded: nothing can talk to it any more
    c.block.appendChild(el('span', '', 'This chat was still running when the window reloaded, and can no longer hear you. Stop it to carry on here.'))
    const b = el('button', 'btn', 'Stop it and continue here')
    b.title = 'Ends that Claude; anything it already wrote stays in the chat'
    b.onclick = () => { b.disabled = true; b.textContent = 'Stopping…'; send({ type: 'chatTakeover', id }) }
    c.block.appendChild(b)
  } else if (blocked) {
    // where, as the host can tell: asked again now and then, as a chat can move
    const w = CHAT.where.get(id)
    if (!w || Date.now() - w.at > 15000) send({ type: 'chatWhere', id })
    const idle = !!w?.idle
    const place = {
      terminal: 'Running in a terminal in this window.',
      claude: 'Running in the Claude Code panel.',
      desktop: 'Open in the Claude app.',
      outside: 'Running in a terminal outside this window.',
    }[w?.where]
    // with a place named, the buttons say the rest
    c.block.appendChild(el('span', '', place || 'Running elsewhere. Reply there, or:'))
    if (w?.where === 'terminal') {
      const show = el('button', 'btn pri', 'Show it')
      show.title = 'Bring that terminal to the front'
      show.onclick = () => send({ type: 'chatShow', id })
      c.block.appendChild(show)
    }
    // idle there, waiting for a message: it can be let go there and carried on here
    if (idle) {
      const take = el('button', 'btn pri', 'Stop it there and continue here')
      take.title = 'Claude is idle there. It is stopped there and this chat carries on here; nothing it wrote is lost'
      take.onclick = () => { take.disabled = true; take.textContent = 'Stopping…'; send({ type: 'chatTakeover', id, idle: true }) }
      c.block.appendChild(take)
    }
    const b = el('button', 'btn', 'New chat from this one')
    b.title = 'A new chat here with this one\'s full history. The original keeps running on its own'
    b.onclick = () => send({ type: 'chatFork', id })
    c.block.appendChild(b)
  } else if (CHAT.cutoff.has(id) && !CHAT.state.get(id)?.busy) {
    c.block.hidden = false
    c.block.appendChild(el('span', '', 'Claude\'s last reply was cut off when the window reloaded or closed.'))
    const go = el('button', 'btn pri', 'Continue')
    go.title = 'Asks Claude to pick up where it stopped'
    go.onclick = () => {
      // sent as its own message: whatever you had typed stays in the box
      // sent as its own message, with no pictures: the draft and its pictures stay
      submit(c, { text: 'Your last reply was cut off when the editor window reloaded. Please continue from where you stopped.' })
    }
    const x = el('button', 'btn', 'Dismiss')
    x.onclick = () => { CHAT.cutoff.delete(id); send({ type: 'chatCutoffClear', id }); paintComposer() }
    c.block.append(go, x)
  }
  const now = CHAT.state.get(id)
  c.ta.placeholder = now?.asks?.length ? 'Answer Claude above first'
    : now?.busy ? 'Queue a message…'
    : where === 'here' || CHAT.here.has(id) ? 'Message Claude… (/ for commands, ! for a shell command)'
      : 'Continue here… (/ for commands, ! for a shell command)'
  paintTip(c)
  paintCtx(c)
  paintPickers(c)
  paintAsks(c)
  paintImages(c)
  paintGo(c)
  paintStatus(c)
}

function paintTip (c) {
  c.tip.replaceChildren()
  c.tip.hidden = CHAT.tipSeen
  if (CHAT.tipSeen) return
  c.tip.appendChild(el('span', '', 'New: reply to Claude here, or start a chat from +. Turn it off in '))
  const set = el('button', 'linkbtn', 'Settings')
  // a one-chat tab has no Settings tab: Cursor's own settings, on this switch
  set.onclick = () => CHAT_ONLY ? send({ type: 'openChatSetting' }) : document.querySelector('.tab[data-tab="settings"]')?.click()
  const x = el('button', 'iconbtn', '×')
  x.title = 'Got it'
  x.onclick = () => tipDone()
  c.tip.append(set, x)
}
function tipDone () {
  if (CHAT.tipSeen) return
  CHAT.tipSeen = true
  send({ type: 'chatTipSeen' })
  if (COMPOSER) paintTip(COMPOSER)
}

function paintGo (c) {
  const st = CHAT.state.get(c.id)
  const empty = !c.ta.value.trim() && !(CHAT.images.get(c.id) || []).length && !(CHAT.files.get(c.id) || []).length
  // "!" switches the box to a shell command, as Claude Code's terminal does: it looks it
  const shell = /^\s*!/.test(c.ta.value) && !(CHAT.images.get(c.id) || []).length
  c.ta.parentNode.classList.toggle('shell', shell)
  c.ta.parentNode.dataset.mode = shell ? 'Shell command · runs in the chat\'s folder' : ''
  if (shell) {
    c.go.replaceChildren(icon('play'))
    c.go.classList.remove('stop')
    c.go.title = 'Run (Enter)'
    c.go.disabled = !c.ta.value.replace(/^\s*!/, '').trim()
    return
  }
  const stop = !!st?.busy && empty
  c.go.replaceChildren(stop ? el('span', 'cstopico') : icon('play'))
  c.go.classList.toggle('stop', stop)
  c.go.title = stop ? 'Stop (Escape)' : st?.busy ? 'Queue this message (Enter)' : 'Send (Enter)'
  c.go.disabled = !stop && empty
}

function paintStatus (c) {
  const st = CHAT.state.get(c.id)
  const done = CHAT.done.get(c.id)
  c.status.textContent = st?.asks?.length ? 'Waiting for you'
    : st?.busy || st?.bg?.length ? '' : done && Date.now() - done.at < 60000 && done.ms ? `Done in ${secs(done.ms)}` : ''
}

const secs = ms => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's'

function paintPickers (c) {
  const p = picksFor(c.id)
  const st = CHAT.state.get(c.id)
  // once Claude is running, what it reports wins: plan approval switches the mode
  if (st?.running && st.mode) p.mode = st.mode
  const opts = (sel, list, value) => {
    // rebuilt only when the choices change: rebuilding shut a list you had open
    const sig = JSON.stringify(list) + '|' + value
    if (sel.dataset.sig === sig) return
    sel.dataset.sig = sig
    sel.replaceChildren()
    for (const [v, label, tip] of list) {
      const o = el('option', '', label)
      o.value = v
      if (tip) o.title = tip
      sel.appendChild(o)
    }
    sel.value = list.some(x => x[0] === value) ? value : list[0][0]
  }
  // the mode Claude is in shows even when it is no longer offered (bypass, after the setting went off)
  const list = modes()
  opts(c.mode, list.some(m => m[0] === p.mode) || p.mode !== BYPASS[0] ? list : [...list, BYPASS], p.mode)
}

// ------------------------------------------------------------ /model and /effort
// Claude's own /model and /effort only work in its terminal, so the box answers
// these two itself: picking one changes this chat, between replies.

const chatModels = () => CHAT.models.length ? CHAT.models.filter(m => m.value !== 'default') : FALLBACK_MODELS
function effortLevels (id) {
  const chosen = chatModels().find(m => m.value === picksFor(id).model)
  return chosen?.efforts?.length ? chosen.efforts : EFFORTS
}
const LOCAL = [
  { name: 'model', hint: '<model>', description: 'Change the model for this chat' },
  { name: 'effort', hint: '<level>', description: 'How hard Claude thinks; new chats start on the last one picked' },
  { name: 'btw', hint: '<question>', description: 'Ask a quick side question without interrupting the chat' },
  { name: 'thinking', hint: 'on|off', description: 'Turn Claude\'s thinking on or off for this chat' },
  { name: 'mcp', hint: '', description: 'The MCP servers this chat has, and whether each is connected' },
]
/** Commands the box handles itself, with whatever follows them. */
const OWN = /^\/(btw|thinking|mcp)(?:\s+([\s\S]*))?$/

/** The choices after "/model " or "/effort ", as slash rows. */
function localChoices (c) {
  const m = /^\/(model|effort)\s+(\S*)$/.exec(c.ta.value)
  if (!m) return null
  const q = m[2].toLowerCase()
  const p = picksFor(c.id)
  const rows = m[1] === 'model'
    ? chatModels().map(x => ({ name: 'model ' + x.value, arg: x.value, description: (x.label || x.value) + (x.value === p.model ? '  (now)' : '') }))
    : effortLevels(c.id).map(l => ({ name: 'effort ' + l, arg: l, description: l[0].toUpperCase() + l.slice(1) + (l === p.effort ? '  (now)' : '') }))
  return rows.filter(x => x.arg.toLowerCase().includes(q)).map(x => ({ ...x, kind: m[1] }))
}

/** "/model opus" or "/effort high": handled here, never sent to Claude. */
function localCommand (c, text) {
  const own = OWN.exec(text.trim())
  if (own) return ownCommand(c, own[1], (own[2] || '').trim())
  const m = /^\/(model|effort)(?:\s+(\S+))?\s*$/.exec(text.trim())
  if (!m) return false
  if (!m[2]) { c.ta.value = '/' + m[1] + ' '; paintSlash(c); return true }
  return applyLocal(c, m[1], m[2])
}

/** /btw, /thinking and /mcp: answered here, beside the chat rather than in it. */
function ownCommand (c, kind, arg) {
  const id = c.id
  const clear = () => { c.ta.value = ''; CHAT.drafts.delete(id); c.slash.hidden = true; c.fit?.(); paintGo(c) }
  if (whereRunning(id) === 'elsewhere') { note(id, `This chat is running somewhere else, so /${kind} cannot ask it from here.`, false); clear(); return true }
  // an old chat has no Claude running yet: the host starts one for this, with nothing sent
  const p = picksFor(id)
  const with_ = { model: p.model, mode: p.mode, effort: p.effort }
  if (kind === 'btw') {
    if (!arg) { c.ta.value = '/btw '; return true }
    const key = Date.now().toString(36)
    CHAT.side.set(id, [...(CHAT.side.get(id) || []), { key, q: arg, a: null }])
    send({ type: 'chatSide', id, key, question: arg, ...with_ })
  } else if (kind === 'thinking') {
    const on = arg ? !/^(off|no|0|false)$/i.test(arg) : !(CHAT.state.get(id)?.thinking ?? true)
    send({ type: 'chatThinking', id, on, ...with_ })
    note(id, on ? 'Thinking is on for this chat.' : 'Thinking is off for this chat: replies come faster, with less reasoning.', false)
  } else if (kind === 'mcp') {
    CHAT.mcp.set(id, 'loading')
    send({ type: 'chatMcp', id, ...with_ })
  }
  clear()
  placeLive()
  return true
}

function applyLocal (c, kind, arg) {
  const p = picksFor(c.id)
  if (kind === 'model') {
    if (!/^[\w.[\]-]{1,60}$/.test(arg)) return false
    p.model = arg
    send({ type: 'chatModel', id: c.id, value: arg })
  } else {
    if (!EFFORTS.includes(arg)) return false
    p.effort = arg
    send({ type: 'chatEffort', id: c.id, value: arg })
    setCfg('chatEffort', arg)
  }
  c.ta.value = ''
  CHAT.drafts.delete(c.id)
  c.slash.hidden = true
  c.fit?.()
  paintGo(c)
  c.status.textContent = kind === 'model' ? 'Model: ' + modelName(arg) : 'Effort: ' + arg
  setTimeout(() => { if (c.status.textContent.startsWith(kind === 'model' ? 'Model:' : 'Effort:')) paintGo(c) }, 2500)
  return true
}

// ------------------------------------------------------------ slash commands

function slashMatches (c) {
  if (c.mention) return c.mention.list.slice(0, 8).map(f => ({ name: f, description: '', kind: 'mention' }))
  const choices = localChoices(c)
  if (choices) return choices.slice(0, 8)
  const m = /^\/([\w:-]*)$/.exec(c.ta.value)
  if (!m) return []
  const q = m[1].toLowerCase()
  const all = [...LOCAL, ...CHAT.commands.filter(x => !LOCAL.some(l => l.name === x.name))]
  return all.filter(x => x.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.toLowerCase().startsWith(q) === b.name.toLowerCase().startsWith(q) ? 0 : a.name.toLowerCase().startsWith(q) ? -1 : 1)
    .slice(0, 8)
}

function paintSlash (c) {
  const list = slashMatches(c)
  c.slash.replaceChildren()
  c.slash.hidden = !list.length
  if (!list.length) return
  c.slashAt = Math.min(c.slashAt, list.length - 1)
  list.forEach((x, i) => {
    const row = el('button', 'cslashrow' + (i === c.slashAt ? ' on' : ''))
    row.append(el('b', '', (x.kind === 'mention' ? '@' : '/') + x.name), el('span', '', x.hint ? `${x.hint}  ${x.description}` : x.description))
    row.onmousedown = e => { e.preventDefault(); pickSlash(c, x) }
    c.slash.appendChild(row)
  })
}

function pickSlash (c, x) {
  if (x.kind === 'mention') { pickMention(c, x); return }
  if (x.kind) { applyLocal(c, x.kind, x.arg); c.ta.focus(); return }
  c.ta.value = '/' + x.name + ' '
  CHAT.drafts.set(c.id, c.ta.value)
  c.slash.hidden = true
  c.ta.focus()
  paintGo(c)
  if (x.name === 'model' || x.name === 'effort') paintSlash(c)      // straight on to its choices
}

function slashKey (c, e) {
  const list = slashMatches(c)
  if (!list.length) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    c.slashAt = (c.slashAt + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length
    paintSlash(c)
    return true
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && (c.mention || !list.some(x => '/' + x.name === c.ta.value.trim())))) {
    e.preventDefault()
    pickSlash(c, list[c.slashAt] || list[0])
    return true
  }
  if (e.key === 'Escape') { e.preventDefault(); c.slash.hidden = true; c.mention = null; return true }
  return false
}

// ------------------------------------------------------------ approvals

function paintAsks (c) {
  const st = CHAT.state.get(c.id)
  const list = st?.asks || []
  // a card being filled in is left alone; only new and answered ones change
  const want = new Set(list.map(a => a.requestId))
  for (const n of [...c.asks.children]) if (!want.has(n.dataset.rid)) n.remove()
  const have = new Set([...c.asks.children].map(n => n.dataset.rid))
  for (const a of list) {
    if (have.has(a.requestId)) continue
    const card = a.kind === 'question' ? questionCard(c, a) : a.kind === 'plan' ? planCard(c, a) : permissionCard(c, a)
    card.dataset.rid = a.requestId
    c.asks.appendChild(card)
  }
  c.asks.hidden = !list.length
}

function answer (c, a, reply) {
  send({ type: 'chatAnswer', id: c.id, requestId: a.requestId, ...reply })
  const st = CHAT.state.get(c.id)
  if (st) st.asks = (st.asks || []).filter(x => x.requestId !== a.requestId)
  paintAsks(c)
  paintStatus(c)
  paintLive()
}

const fileName = p => String(p || '').split('/').pop()

/** What Claude wants to do, as a sentence. */
function askTitle (a) {
  const i = a.input || {}
  // Claude's own sentence for it, when it gives one
  if (a.title) return a.title
  const who = a.agent ? 'An agent' : 'Claude'
  return askTitleFor(a, i).replace(/^Claude/, who)
}
function askTitleFor (a, i) {
  switch (a.tool) {
    case 'Bash': return 'Claude wants to run a command'
    case 'Write': return `Claude wants to write ${fileName(i.file_path) || 'a file'}`
    case 'Edit': case 'MultiEdit': return `Claude wants to edit ${fileName(i.file_path) || 'a file'}`
    case 'NotebookEdit': return `Claude wants to edit ${fileName(i.notebook_path) || 'a notebook'}`
    case 'WebFetch': return 'Claude wants to fetch a web page'
    case 'WebSearch': return 'Claude wants to search the web'
    case 'Read': return `Claude wants to read ${fileName(i.file_path) || 'a file'}`
    default: return `Claude wants to use ${a.name || a.tool.replace(/^mcp__([^_]+)__/, '$1: ')}${a.server ? ` (${a.server})` : ''}`
  }
}

function pre (text, cls) {
  const p = el('pre', 'caskpre' + (cls ? ' ' + cls : ''))
  p.textContent = text
  return p
}

function diffBox (pairs) {
  const box = el('div', 'caskdiff')
  for (const [a, b] of pairs) {
    for (const l of String(a || '').split('\n')) if (a) box.appendChild(el('div', 'dl del', '- ' + l))
    for (const l of String(b || '').split('\n')) if (b) box.appendChild(el('div', 'dl add', '+ ' + l))
    box.appendChild(el('div', 'dl gap', ''))
  }
  box.lastChild?.remove()
  return box
}

function askBody (a) {
  const i = a.input || {}
  const wrap = el('div', 'caskbody')
  const path = i.file_path || i.notebook_path
  if (path) {
    const p = el('div', 'caskpath', path)
    p.title = 'Open the file'
    p.onclick = () => send({ type: 'openFile', path })
    wrap.appendChild(p)
  }
  if (a.tool === 'Bash') {
    wrap.appendChild(pre(String(i.command || '')))
    if (i.run_in_background) wrap.appendChild(el('div', 'caskwhy', 'Runs in the background, and keeps running after this reply.'))
    if (i.description) wrap.appendChild(el('div', 'caskwhy', i.description))
  } else if (a.tool === 'Write') {
    const lines = String(i.content || '').split('\n')
    wrap.appendChild(pre(lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… ${lines.length - 40} more lines` : '')))
  } else if (a.tool === 'Edit') {
    if (i.replace_all) wrap.appendChild(el('div', 'caskwhy', 'Replaces every match in the file, not just one.'))
    wrap.appendChild(diffBox([[i.old_string, i.new_string]]))
  } else if (a.tool === 'MultiEdit') {
    wrap.appendChild(diffBox((i.edits || []).map(e => [e.old_string, e.new_string])))
  } else if (a.tool === 'WebFetch') {
    wrap.appendChild(el('div', 'caskwhy', String(i.url || '')))
  } else if (a.tool === 'WebSearch') {
    wrap.appendChild(el('div', 'caskwhy', String(i.query || '')))
  } else if (a.tool === 'NotebookEdit') {
    wrap.appendChild(el('div', 'caskwhy', `${i.edit_mode === 'delete' ? 'Deletes' : i.edit_mode === 'insert' ? 'Inserts' : 'Replaces'} a ${i.cell_type || 'cell'}${i.cell_id ? ` (${i.cell_id})` : ''}`))
    if (i.new_source != null) wrap.appendChild(pre(String(i.new_source).slice(0, 4000)))
  } else if (a.tool !== 'Read') {
    // any other tool shows its whole input, not just the file it names: that is what is being approved
    const json = JSON.stringify(i, null, 2) || ''
    wrap.appendChild(pre(json.length > 3000 ? json.slice(0, 3000) + '\n…' : json))
  }
  if (typeof a.reason === 'string' && a.reason) wrap.appendChild(el('div', 'caskwhy', a.reason))
  return wrap
}

/** "Always allow" saves the rule Claude suggests; say what that rule is. */
function alwaysTip (a) {
  const where = { session: 'for the rest of this session', localSettings: 'in this project, on this computer', projectSettings: 'in this project', userSettings: 'everywhere' }
  return a.suggestions.map(s => {
    const rules = (s.rules || []).map(r => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName).join(', ')
    if (s.type === 'setMode') return `Switch to ${s.mode} ${where[s.destination] || ''}`.trim()
    return `Allow ${rules || 'this'} ${where[s.destination] || ''}`.trim()
  }).join('\n')
}

function permissionCard (c, a) {
  if (a.kind === 'dialog') return dialogCard(c, a)
  const card = el('div', 'cask')
  card.appendChild(el('div', 'caskhead', askTitle(a)))
  card.appendChild(askBody(a))
  const acts = el('div', 'caskacts')
  // a risky one leads with No, as Claude's terminal does
  const allow = el('button', a.defaultNo ? 'btn' : 'btn pri', 'Allow')
  allow.onclick = () => answer(c, a, { allow: true })
  acts.appendChild(allow)
  if (['Edit', 'Write', 'MultiEdit'].includes(a.tool)) {
    const diff = el('button', 'btn', 'Open diff')
    diff.title = 'See the change beside the file as it is now, in the editor'
    diff.onclick = () => send({ type: 'chatAskDiff', id: c.id, requestId: a.requestId })
    acts.appendChild(diff)
  }
  if (a.suggestions.length && !a.noAlways) {
    const always = el('button', 'btn', 'Always allow')
    always.title = alwaysTip(a)
    always.onclick = () => answer(c, a, { allow: true, always: true })
    acts.appendChild(always)
  }
  const deny = el('button', a.defaultNo ? 'btn pri' : 'btn', 'Deny')
  deny.title = 'Claude is told no, and tries another way'
  deny.onclick = () => answer(c, a, { allow: false })
  const halt = el('button', 'btn', 'Deny and stop')
  halt.title = 'Claude is told no, and the reply ends here'
  halt.onclick = () => answer(c, a, { allow: false, stop: true })
  acts.append(deny, halt)
  const instead = el('input', 'caskinput')
  instead.placeholder = 'Or tell Claude what to do instead, then Enter'
  instead.onkeydown = e => {
    if (e.key === 'Enter' && instead.value.trim()) answer(c, a, { allow: false, message: instead.value.trim() })
  }
  card.append(acts, instead)
  return card
}

/** Auto mode stopped to ask whether to keep going. */
function dialogCard (c, a) {
  const card = el('div', 'cask')
  card.appendChild(el('div', 'caskhead', a.title || 'Auto mode needs you'))
  const body = el('div', 'caskbody')
  for (const t of a.paragraphs?.length ? a.paragraphs : ['Auto mode is waiting for you to choose: keep going, or stop this reply.']) body.appendChild(el('div', 'caskwhy', t))
  card.appendChild(body)
  const acts = el('div', 'caskacts')
  const go = el('button', 'btn pri', 'Continue')
  go.onclick = () => answer(c, a, { choice: 'continue' })
  const halt = el('button', 'btn', 'Stop')
  halt.onclick = () => answer(c, a, { choice: 'interrupt' })
  acts.append(go, halt)
  card.appendChild(acts)
  return card
}

function questionCard (c, a) {
  const card = el('div', 'cask')
  const qs = Array.isArray(a.input?.questions) ? a.input.questions : []
  const chosen = qs.map(() => new Set())
  const other = []
  // pictures pasted into an answer: a question takes text only, so the host
  // saves them as files and the answer tells Claude where to open them
  const pics = qs.map(() => [])
  const sendBtn = el('button', 'btn pri', qs.length > 1 ? 'Send answers' : 'Send answer')
  let loading = 0                 // pictures still being read: Send waits for them
  const ready = () => { sendBtn.disabled = loading > 0 || !qs.every((q, i) => chosen[i].size || other[i]?.value.trim() || pics[i].length) }
  card.appendChild(el('div', 'caskhead', qs.length > 1 ? 'Claude has some questions' : 'Claude has a question'))
  qs.forEach((q, i) => {
    const box = el('div', 'caskq')
    if (q.header) box.appendChild(el('span', 'caskchip', q.header))
    box.appendChild(el('div', 'caskqtext', q.question || ''))
    const opts = el('div', 'caskopts')
    for (const o of q.options || []) {
      const b = el('button', 'caskopt')
      b.appendChild(el('b', '', o.label || ''))
      if (o.description) b.appendChild(el('span', '', o.description))
      // a choice can come with a preview of what it would look like
      if (o.preview) b.appendChild(el('pre', 'caskpreview', String(o.preview)))
      b.onclick = () => {
        if (!q.multiSelect) { chosen[i].clear(); for (const x of opts.children) x.classList.remove('on') }
        if (chosen[i].has(o.label)) { chosen[i].delete(o.label); b.classList.remove('on') } else { chosen[i].add(o.label); b.classList.add('on') }
        if (other[i]) other[i].value = ''
        ready()
        // one question with one answer goes straight back, as a click in the terminal does
        if (qs.length === 1 && !q.multiSelect) sendBtn.click()
      }
      opts.appendChild(b)
    }
    const own = el('input', 'caskinput')
    own.placeholder = 'Something else…'
    own.oninput = () => { if (own.value.trim()) { chosen[i].clear(); for (const x of opts.children) x.classList.remove('on') } ready() }
    own.onkeydown = e => { if (e.key === 'Enter' && !sendBtn.disabled) sendBtn.click() }
    other[i] = own
    const strip = el('div', 'caskpics')
    const paintPics = () => {
      strip.replaceChildren()
      pics[i].forEach((im, k) => {
        const chip = el('div', 'cimg')
        const img = document.createElement('img'); img.src = im.url
        const x = el('button', 'cimgx', '×'); x.title = 'Remove'
        x.onclick = () => { pics[i].splice(k, 1); paintPics(); ready() }
        chip.append(img, x)
        strip.appendChild(chip)
      })
      strip.hidden = !pics[i].length
    }
    own.onpaste = e => {
      const files = [...(e.clipboardData?.items || [])].filter(t => t.type.startsWith('image/')).map(t => t.getAsFile()).filter(Boolean)
      if (!files.length) return
      e.preventDefault()
      for (const f of files) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type) || f.size > MAX_IMAGE) { note(c.id, 'Only PNG, JPEG, GIF and WebP pictures under 5 MB can be sent.', true); continue }
        const r = new FileReader()
        loading++; ready()
        r.onerror = () => { loading--; note(c.id, 'That picture could not be read.', true); ready() }
        r.onload = () => {
          loading--
          const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(r.result))
          if (!m) { ready(); return }
          pics[i] = [...pics[i], { mediaType: m[1], data: m[2], url: String(r.result) }].slice(0, 4)
          for (const x of opts.children) x.classList.remove('on')
          chosen[i].clear()
          paintPics(); ready()
        }
        r.readAsDataURL(f)
      }
    }
    own.placeholder = 'Something else… (you can paste a picture)'
    paintPics()
    box.append(opts, own, strip)
    card.appendChild(box)
  })
  sendBtn.onclick = () => {
    const answers = {}
    const images = {}
    qs.forEach((q, i) => {
      answers[q.question] = other[i].value.trim() || [...chosen[i]].join(', ')
      if (pics[i].length) images[q.question] = pics[i].map(p => ({ mediaType: p.mediaType, data: p.data }))
    })
    answer(c, a, { allow: true, answers, images })
  }
  const skip = el('button', 'btn', 'Skip')
  skip.title = 'Tell Claude you would rather not answer'
  skip.onclick = () => answer(c, a, { allow: false, message: 'The user skipped this question. Carry on with your best judgement, or ask in plain text.' })
  const acts = el('div', 'caskacts')
  acts.append(sendBtn, skip)
  card.appendChild(acts)
  ready()
  return card
}

function planCard (c, a) {
  const card = el('div', 'cask')
  card.appendChild(el('div', 'caskhead', 'Claude has a plan for you to approve'))
  const plan = el('div', 'caskplan bubble')
  plan.innerHTML = window.md(String(a.input?.plan || ''))
  card.appendChild(plan)
  const acts = el('div', 'caskacts')
  const go = el('button', 'btn pri', 'Approve')
  go.title = 'Claude starts, asking before each edit'
  go.onclick = () => { send({ type: 'chatMode', id: c.id, value: 'default' }); answer(c, a, { allow: true }) }
  const goEdits = el('button', 'btn', 'Approve, accept edits')
  goEdits.title = 'Claude starts, and file edits go through without asking'
  goEdits.onclick = () => { send({ type: 'chatMode', id: c.id, value: 'acceptEdits' }); answer(c, a, { allow: true }) }
  acts.append(go, goEdits)
  const more = el('input', 'caskinput')
  more.placeholder = 'Keep planning: tell Claude what to change, then Enter'
  more.onkeydown = e => { if (e.key === 'Enter' && more.value.trim()) answer(c, a, { allow: false, message: more.value.trim() }) }
  card.append(acts, more)
  return card
}

// ------------------------------------------------------------ new chat

/** The + button: a chat run here, or the terminal it always opened. */
function newChatMenu (anchor) {
  if (!chatOn()) { send({ type: 'newChat', where: 'terminal' }); return }
  document.querySelectorAll('body > .menu.newmenu').forEach(m => m.remove())
  const menu = el('div', 'menu newmenu')
  const item = (ico, label, hint, where) => {
    const b = el('button', 'menuitem')
    b.append(icon(ico, 'mico'), el('span', '', label), el('em', '', hint))
    b.onclick = () => { kill(); send({ type: 'newChat', where }) }
    menu.appendChild(b)
  }
  item('message', 'New chat here', 'in the logbook', 'logbook')
  item('terminal', 'New chat in a terminal', 'as before', 'terminal')
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8))}px`
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - m.height - 8)}px`
  const kill = dismissOn(menu)
}

// ------------------------------------------------------------ messages

/** Drop the sent copy and the half-written reply once the transcript has them. */
function caughtUp (t) {
  const id = t.id
  const echoes = CHAT.echo.get(id)
  if (echoes?.length) {
    const users = (t.turns || []).filter(x => x.role === 'user' && x.text).slice(-(echoes.length + 2))
    const busy = !!CHAT.state.get(id)?.busy
    const left = echoes.filter(echo => {
      // a queued message leaves when its own turn starts or it is taken back, not on matching words
      if (echo.queued && echo.uuid && busy) return true
      const want = echo.text.trim().slice(0, 120)
      if (want && users.some(u => String(u.text).includes(want))) return false
      // a queued one waits as long as Claude is busy; an unqueued one shows for 15s at most
      return echo.queued && busy ? Date.now() - echo.at < 600000 : Date.now() - echo.at < 15000
    })
    if (left.length) CHAT.echo.set(id, left); else CHAT.echo.delete(id)
  }
  if (CHAT.landed.has(id)) { CHAT.landed.delete(id); CHAT.partial.delete(id) }
  // a command sent along with a message is in the transcript once that message is
  const sh = CHAT.shell.get(id)
  if (sh?.length) {
    const users = (t.turns || []).filter(x => x.role === 'user' && x.text).slice(-4)
    const left = sh.filter(x => !x.sentWith || !(users.some(u => String(u.text).includes('! ' + x.cmd.slice(0, 80))) || Date.now() - x.sentAt > 15000))
    if (left.length) CHAT.shell.set(id, left); else CHAT.shell.delete(id)
  }
}

if (!BOARD_MODE) {
  window.addEventListener('message', e => {
    const m = e.data
    if (!m || typeof m.type !== 'string') return
    // main.js has already drawn what arrived; the box goes back under it
    if (m.type === 'session' && m.data) {
      caughtUp(m.data)
      chatMount()
      return
    }
    if (m.type === 'pendingChat') {
      if (m.here) CHAT.here.set(m.id, { copyOf: m.copyOf || '', folder: m.folder || '' })
      chatMount()
      if (m.here) requestAnimationFrame(() => COMPOSER?.ta.focus())
      return
    }
    // the Settings switch may have flipped
    if (m.type === 'env' && 'chatTipSeen' in m) { CHAT.tipSeen = !!m.chatTipSeen; if (COMPOSER) paintTip(COMPOSER) }
    if (m.type === 'env' && m.cfg) { chatMount(); if (!chatOn()) return }
    if (m.type === 'sessions' || m.type === 'env') { if (COMPOSER && chatTarget()?.id === COMPOSER.id) paintComposer(); return }
    if (m.type === 'chatShellOut' || m.type === 'chatShellEnd') {
      const sh = (CHAT.shell.get(m.id) || []).find(x => x.key === m.key)
      if (!sh) return
      if (m.chunk) sh.out = (sh.out + m.chunk).slice(-200000)
      if (m.type === 'chatShellEnd') { sh.running = false; sh.code = m.code }
      if (COMPOSER?.id === m.id) placeLive()
      return
    }
    if (m.type === 'chatWhere') { CHAT.where.set(m.id, { where: m.where || '', idle: !!m.idle, at: Date.now() }); paintComposer(); return }
    // the full list of slash commands and models, learned from Claude or kept from before
    if (m.type === 'chatKnown') {
      if (m.commands?.length) CHAT.commands = m.commands
      if (m.models?.length) CHAT.models = m.models
      return
    }
    if (m.type === 'chatTaskOutput') {
      const key = m.id + '|' + m.taskId
      const out = CHAT.taskOut.get(key)
      if (!out) return
      if (m.output === null) { out.failed = true; out.loading = false }
      else Object.assign(out, { output: m.output, truncated: m.truncated, loading: false, failed: false })
      // only its own box changes: redrawing everything would reset what you were scrolled to
      if (COMPOSER?.id === m.id) placeLive()
      return
    }
    if (m.type === 'chatEditor') {
      CHAT.editor = { label: m.label || '', file: m.file || '' }
      if (COMPOSER) paintCtx(COMPOSER)
      return
    }
    if (m.type === 'chatFilesList') {
      if (COMPOSER?.id === m.id && COMPOSER.mention && COMPOSER.mention.q === m.q) {
        COMPOSER.mention.list = m.list || []
        COMPOSER.slashAt = 0
        paintSlash(COMPOSER)
      }
      return
    }
    if (m.type === 'chatCutoff') { CHAT.cutoff = new Set(m.ids || []); paintComposer(); return }
    if (!m.type.startsWith('chat') || !m.id) return
    const id = m.id
    const st = CHAT.state.get(id) || { id, asks: [] }
    switch (m.type) {
      case 'chatState':
        if (m.state.busy && !st.busy) CHAT.busySince.set(id, Date.now())
        // a task that has gone takes its open output and its "Stopping…" with it
        for (const k of [...CHAT.taskOut.keys(), ...CHAT.stopping]) {
          if (k.startsWith(id + '|') && !(m.state.bg || []).some(t => k === id + '|' + t.id)) { CHAT.taskOut.delete(k); CHAT.stopping.delete(k) }
        }
        CHAT.state.set(id, { ...m.state })
        if (m.state.commands?.length) CHAT.commands = m.state.commands
        if (m.state.models?.length) CHAT.models = m.state.models
        if (m.state.partial) CHAT.partial.set(id, m.state.partial)
        break
      case 'chatPartial': {
        if (m.partial) CHAT.partial.set(id, m.partial); else CHAT.partial.delete(id)
        // the hottest path: while the reply grows, only its bubble and the status
        // word change - not the box, its pictures, the asks or any command output
        const bubble = COMPOSER?.id === id && m.partial?.text && COMPOSER.live.querySelector('.chatstream .bubble')
        const word = bubble && COMPOSER.live.querySelector('.chatworking:not(.wait) > span:nth-child(2)')
        if (bubble && word) {
          // a long reply is redrawn at most every half second while it grows, not with every few words
          const now = Date.now()
          if (m.partial.text.length > 20000 && now - (CHAT.drewAt || 0) < 500) {
            clearTimeout(CHAT.drawLater)
            CHAT.drawLater = setTimeout(() => { if (COMPOSER?.id === id) placeLive() }, 500)
            return
          }
          CHAT.drewAt = now
          bubble.innerHTML = window.md(m.partial.text)
          word.textContent = 'Writing…'
          if (FOLLOW) stickToEnd(COMPOSER.live.parentNode)
          return
        }
        // no text yet (thinking, a tool starting, an agent's step): the words change in place,
        // and the cards, buttons and thinking you may be scrolled in are left alone
        const p = m.partial
        const live = COMPOSER?.id === id && COMPOSER.live
        const w = live && !p?.text && live.querySelector('.chatworking:not(.wait) > span:nth-child(2)')
        const agentLine = live && live.querySelector('.chatagent')
        const thought = live && live.querySelector('.chatthinktext')
        if (w && !live.querySelector('.chatstream') && !!agentLine === !!p?.agent && !!thought === !!p?.thought) {
          w.textContent = busyWord(CHAT.state.get(id), p)
          if (agentLine) agentLine.textContent = `Agent · ${p.agent}`
          if (thought && thought.textContent !== p.thought) thought.textContent = p.thought
          return
        }
        break
      }
      case 'chatLanded':
        CHAT.landed.add(id)
        break
      case 'chatAsk':
        st.asks = [...(st.asks || []).filter(a => a.requestId !== m.ask.requestId), m.ask]
        CHAT.state.set(id, st)
        break
      case 'chatAskGone':
        st.asks = (st.asks || []).filter(a => a.requestId !== m.requestId)
        CHAT.state.set(id, st)
        break
      case 'chatDone':
        CHAT.state.set(id, { ...st, busy: false, asks: [] })
        CHAT.partial.delete(id)
        CHAT.done.set(id, { at: Date.now(), ms: m.ms })
        setTimeout(() => { if (COMPOSER?.id === id) paintStatus(COMPOSER) }, 61000)
        // the sign-in note says what to do about the error; the error itself adds nothing
        if (CHAT.notes.get(id)?.action) break
        if (m.error && !m.stopped) note(id, m.error, true)
        else if (m.stopped) note(id, 'Stopped. Type to carry on.', false)
        // tools you said no to, so it is clear why Claude went another way
        else if (m.denied) note(id, `Claude wasn't allowed to use: ${m.denied}.`, false)
        break
      case 'chatQueue': {
        const echoes = CHAT.echo.get(id) || []
        const e = echoes.find(x => x.uuid === m.uuid)
        if (!e) return
        if (m.state === 'started') { e.queued = false; break }
        if (m.state === 'notcancelled') { note(id, 'Too late to take that back: Claude has already started on it.', false); break }
        if (!['cancelled', 'discarded', 'refused'].includes(m.state)) return
        // taken back: it leaves the chat, and its words and attachments come back to the box
        CHAT.echo.set(id, echoes.filter(x => x !== e))
        if (m.state === 'cancelled') giveBack(id, e)
        break
      }
      case 'chatNotice':
        note(id, m.text, false, m.action === 'terminal' ? { label: 'Open Claude in a terminal', msg: { type: 'chatTerminal' } } : undefined)
        break
      case 'chatLimit': {
        const when = m.resetsAt ? new Date(m.resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
        const which = { five_hour: 'five-hour', seven_day: 'weekly', seven_day_opus: 'weekly' }[m.kind] || ''
        note(id, m.status === 'rejected'
          ? `You've hit your ${which ? which + ' ' : ''}usage limit.${when ? ` It resets at ${when}.` : ''}`
          : `You're close to your ${which ? which + ' ' : ''}usage limit.${when ? ` It resets at ${when}.` : ''}`, m.status === 'rejected')
        break
      }
      case 'chatTitle': {
        const h2 = COMPOSER?.id === id && document.querySelector('#detail .dtop h2')
        if (h2) h2.textContent = m.title
        break
      }
      case 'chatMoved': {
        // /clear: the chat goes on under a new id; the view follows it there
        for (const k of ['state', 'echo', 'partial', 'notes', 'picks', 'side', 'mcp', 'drafts', 'images', 'files', 'sentLog', 'shell', 'todosFold']) {
          if (CHAT[k].has(id)) { CHAT[k].set(m.to, CHAT[k].get(id)); CHAT[k].delete(id) }
        }
        CHAT.echo.delete(m.to)
        CHAT.here.set(m.to, { folder: '' })
        if (COMPOSER?.id === id) {
          COMPOSER = null
          // shown as a new chat until its file appears, then as itself (a one-chat tab moves with it)
          showPending(m.to)
          send({ type: 'chatFollow', id: m.to })
          note(m.to, 'Cleared. This is a fresh chat; the earlier one is still in the list.', false)
          chatMount()
        }
        return
      }
      case 'chatSideAnswer': {
        const q = (CHAT.side.get(id) || []).find(x => x.key === m.key)
        if (q) q.a = m.answer === null ? false : m.answer
        break
      }
      case 'chatMcpList':
        CHAT.mcp.set(id, Array.isArray(m.list) ? m.list : 'unavailable')
        break
      case 'chatTaskStopFailed':
        CHAT.stopping.delete(id + '|' + m.taskId)
        note(id, 'That task did not stop. Try Stop again.', true)
        break
      case 'chatAuth':
        note(id, 'Claude is signed out, or its sign-in has expired. Sign in again, then send your message again.', true,
          { label: 'Sign in again', msg: { type: 'chatLogin' } })
        break
      case 'chatFallback':
        note(id, `Claude switched to ${m.model}${FALLBACK_WHY[m.trigger] ? ` because ${FALLBACK_WHY[m.trigger]}` : ' by itself'}. Pick another with /model.`, false)
        break
      case 'chatExit':
        CHAT.state.set(id, { ...st, running: false, busy: false, asks: [], endedAt: Date.now() })
        CHAT.partial.delete(id)
        if (m.error) note(id, m.error, true)
        break
      case 'chatError': {
        // nothing was sent: the words go back in the box rather than being lost
        // only the newest: earlier ones may have gone through and just not landed yet
        const echoes = CHAT.echo.get(id) || []
        const last = echoes[echoes.length - 1]
        if (echoes.length > 1) CHAT.echo.set(id, echoes.slice(0, -1)); else CHAT.echo.delete(id)
        // and the commands it carried wait for the retry rather than counting as sent
        for (const sh of CHAT.shell.get(id) || []) if (last && sh.sentWith === last.text) { sh.sentWith = null; sh.sentAt = 0 }
        CHAT.state.set(id, { ...st, busy: false })
        if (last) giveBack(id, last)
        note(id, m.error, true)
        break
      }
      default:
        return
    }
    if (COMPOSER?.id === id) { placeLive(); paintComposer(); if (typeof paintRunner === 'function') paintRunner() }
  })
}
