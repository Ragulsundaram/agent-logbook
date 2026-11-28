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
  inflight: new Set(),   // reads under way, each { id }: /clear moves the ones it catches to the new id
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
  mcpBusy: new Map(),    // chat id|server -> the number of the turn-off, reconnect or sign-in under way
  mcpFold: new Map(),    // chat id|group -> folded or not, once changed by hand
  mcpTop: new Map(),     // chat id -> how far the server list is scrolled
  mcpSeq: 0,             // numbers each /mcp action, so a reply clears only its own
  over: new Map(),       // chat id -> { pictures, files, sent }: what a message left out
  editor: { label: '', file: '' },   // what the editor has open, which goes with your message
  skipCtx: new Set(),    // chats whose next message goes without the editor's file
  files: new Map(),      // chat id -> attached PDFs and text files waiting to go
  layout: new Map(),     // chat id -> the draft as text and the pictures and files between it, so chips keep their places
  drops: new Map(),      // request key -> the read slot of files dropped from the Explorer, while the extension reads them
  thoughtOpen: new Set(), // chats whose live thinking you opened
  stopping: new Set(),    // "chat id|task id": Stop pressed, until the task goes
  todosFold: new Map(),  // chat id -> true/false: you folded or opened its to-do list (a finished one folds by itself)
}
let COMPOSER = null
// the usage-limit notice the extension says to show, one for every view (null: none)
let LIMIT_NOTICE = null

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
const MAX_IMAGE = sharedRules.LIMITS.picture

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
  // sent from this box a moment ago: Claude is starting here (or waiting for the last one to leave)
  if (st?.sentHere && Date.now() - st.sentHere < 30000) return 'here'
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
    // the status, model, mode and live area were moved out of the box: they go too
    if (COMPOSER) { refreshPoints(COMPOSER); for (const n of [COMPOSER.root, COMPOSER.live, COMPOSER.status, COMPOSER.model, COMPOSER.mode]) n.remove(); COMPOSER = null }
    return
  }
  const t = chatTarget()
  if (!t) return
  const d = $('#detail')
  const fresh = !COMPOSER || COMPOSER.id !== t.id
  // another chat on screen: an Enter the last one left waiting for its files does not go
  // unseen, and files still on their way keep their places for when you come back
  if (COMPOSER && fresh) { callOffSend(COMPOSER.id); refreshPoints(COMPOSER) }
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

function setMode (c, value, keep = true) {
  const p = picksFor(c.id)
  p.mode = value
  // a running Claude answers each pick (chatModeDone, by this number): until the answer
  // to the latest one comes, your pick shows, not the mode Claude still reports
  const st = CHAT.state.get(c.id)
  const req = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  p.modeAsk = st?.running ? { value, req } : null
  paintPickers(c)
  send({ type: 'chatMode', id: c.id, value, req })
  // and every new chat after it - except bypass, which is picked chat by chat
  if (keep && value !== 'bypassPermissions') setCfg('chatPermissionMode', value)
}
/**
 * Shift+Tab in the box steps through the modes, as it does in Claude Code's
 * terminal - for this chat only: a key pressed in passing never changes the
 * default every new chat starts with.
 */
function cycleMode (c) {
  const list = modes()
  const i = list.findIndex(m => m[0] === picksFor(c.id).mode)
  setMode(c, list[(i + 1) % list.length][0], false)
}

/**
 * The chat view closed (back to the list, another page): an Enter waiting for files
 * is called off rather than sent where nobody sees it. The draft and the files stay.
 */
function chatViewClosed () {
  if (COMPOSER) callOffSend(COMPOSER.id)
}

/**
 * The line under the box: the reply's status joins the chat's details on its left,
 * the model and mode sit on its right. A new chat has no footer yet, so they get a
 * line of their own under the box.
 */
function placeStatusLine (foot) {
  const c = COMPOSER
  // the footer's own line, not the composer's spare one inside the same footer
  const details = foot?.querySelector(':scope > .fmeta > .fnums')
  const ctrls = foot?.querySelector(':scope > .fmeta > .fctrls')
  c.under.hidden = !!(details && ctrls)
  const at = details || c.underText
  if (c.status.parentNode !== at) at.appendChild(c.status)
  const side = ctrls || c.underCtrls
  if (c.model.parentNode !== side) side.append(c.model, c.mode)
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

/**
 * /mcp: the chat's servers grouped the way you act on them - what needs you
 * first, then what is connected (folded when long), then what is off. Each row
 * has one switch for on and off, and Sign in or Reconnect only when it applies.
 */
function mcpCard (id, servers) {
  const w = el('div', 'chatside mcpcard')
  const head = el('div', 'shhead')
  head.appendChild(el('span', 'bgkind', 'MCP servers'))
  const sum = el('span', 'shcmd mcpsum', '')
  head.appendChild(sum)
  const x = el('button', 'iconbtn', '×')
  x.title = 'Close (Escape)'
  x.setAttribute('aria-label', 'Close')
  x.dataset.f = 'x'
  x.onclick = () => { CHAT.mcp.delete(id); paintLive() }
  head.appendChild(x)
  w.appendChild(head)
  if (servers === 'loading') { w.appendChild(el('div', 'chatmeta', 'Asking Claude…')); return w }
  if (servers === 'unavailable') { w.appendChild(el('div', 'chatmeta', 'Claude did not answer. Try /mcp again.')); return w }
  if (!servers.length) { w.appendChild(el('div', 'chatmeta', 'This chat has no MCP servers.')); return w }
  const groups = [
    ['need', 'Needs you', servers.filter(v => v.status === 'needs-auth' || v.status === 'failed')],
    ['on', 'Connected', servers.filter(v => v.status === 'connected' || v.status === 'pending')],
    ['off', 'Off', servers.filter(v => v.status === 'disabled')],
    ['other', 'Other', servers.filter(v => !['needs-auth', 'failed', 'connected', 'pending', 'disabled'].includes(v.status))],
  ].filter(g => g[2].length)
  sum.textContent = groups.map(([, label, list]) => `${list.length} ${label.toLowerCase()}`).join(' · ')
  const list = el('div', 'mcplist')
  for (const [key, label, rows] of groups) {
    const fk = id + '|' + key
    // a long connected list folds by default; what needs you never does
    const folded = CHAT.mcpFold.has(fk) ? CHAT.mcpFold.get(fk) : key === 'on' && rows.length > 6 && groups.length > 1
    const gh = el('button', 'mcpgroup')
    gh.setAttribute('aria-expanded', String(!folded))
    gh.append(el('span', 'chev2', folded ? '›' : '⌄'), el('span', '', label), el('span', 'mcpcount', String(rows.length)))
    gh.dataset.f = 'g|' + key
    gh.onclick = () => { CHAT.mcpFold.set(fk, !folded); paintLive(); mcpRefocus(gh.dataset.f) }
    list.appendChild(gh)
    if (folded) continue
    for (const v of rows) list.appendChild(mcpRow(id, v))
  }
  w.appendChild(list)
  // and the list stays scrolled where you left it
  const top = CHAT.mcpTop.get(id)
  if (top) requestAnimationFrame(() => { list.scrollTop = top })
  list.onscroll = () => CHAT.mcpTop.set(id, list.scrollTop)
  return w
}

/** An action is over: its row is free again, unless a newer action on the same server is still under way. */
function mcpDone (id, name, seq) {
  const key = id + '|' + name
  if (!seq || CHAT.mcpBusy.get(key) === seq) CHAT.mcpBusy.delete(key)
}

/** The card is redrawn on every change: keyboard focus goes back to the control it was on. */
function mcpRefocus (f) {
  requestAnimationFrame(() => {
    const t = [...document.querySelectorAll('.mcpcard [data-f]')].find(n => n.dataset.f === f)
    // gone (moved into a folded group): its group's header, never Close, which Enter would press
    ;(t || document.querySelector('.mcpcard .mcpgroup'))?.focus()
  })
}

function mcpRow (id, v) {
  const row = el('div', 'mcprow ' + ({ connected: 'ok', failed: 'bad', 'needs-auth': 'auth', pending: 'wait', disabled: 'off' }[v.status] || ''))
  // "claude.ai Gmail" and "plugin:postman:postman" read better as the name, with where it comes from beside it
  let name = v.name, from = ''
  const m = /^claude\.ai (.+)$/.exec(name) || /^plugin:([^:]+):(.+)$/.exec(name)
  if (m) { from = name.startsWith('plugin:') ? 'plugin' : 'claude.ai'; name = m[m.length - 1] }
  const nm = el('span', 'mcpname', name)
  nm.title = v.name
  row.append(el('span', 'mcpdot'), nm)
  if (from) row.appendChild(el('span', 'mcpfrom', from))
  const key = id + '|' + v.name
  const busy = CHAT.mcpBusy.has(key)
  const go = act => { const seq = ++CHAT.mcpSeq; CHAT.mcpBusy.set(key, seq); send({ type: 'chatMcpAct', id, act, name: v.name, seq }); paintLive(); mcpRefocus('s|' + v.name) }
  const state = text => { const s = el('span', 'mcpstate', text); s.setAttribute('role', 'status'); return s }
  if (busy) row.appendChild(state('Working…'))
  else if (v.status === 'pending') row.appendChild(state('Connecting…'))
  else if (v.status === 'needs-auth' || v.status === 'failed') {
    const b = el('button', 'mcplink', v.status === 'failed' ? 'Reconnect' : 'Sign in')
    b.title = v.status === 'failed' ? 'Try connecting to this server again' : 'Opens the sign-in page in your browser'
    b.dataset.f = 'l|' + v.name
    b.onclick = () => go(v.status === 'failed' ? 'reconnect' : 'signin')
    row.appendChild(b)
  }
  // one switch, as in Claude's own settings; off is kept for this folder, as /mcp does in the terminal
  const on = v.status !== 'disabled'
  const sw = el('button', 'mcpswitch' + (on ? ' on' : ''))
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(on))
  sw.setAttribute('aria-label', v.name)
  sw.title = on ? 'Turn off for chats in this folder' : 'Turn on for chats in this folder'
  // held, not disabled: a disabled button drops keyboard focus while the change goes through
  const held = busy || v.status === 'pending'
  sw.setAttribute('aria-disabled', String(held))
  sw.dataset.f = 's|' + v.name
  sw.onclick = () => { if (!held) go(on ? 'off' : 'on') }
  row.appendChild(sw)
  return row
}

function paintLive () {
  if (!COMPOSER) return
  const id = COMPOSER.id
  const live = COMPOSER.live
  // the /mcp card is rebuilt with everything else: keyboard focus goes back where it was
  const mcpF = document.activeElement?.closest?.('.mcpcard') && document.activeElement.dataset?.f
  if (mcpF) mcpRefocus(mcpF)
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
  if (servers) live.appendChild(mcpCard(id, servers))
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
  // what was left out of a message: its own line, so a passing notice never wipes it
  const over = CHAT.over.get(id)
  if (over) {
    const n = el('div', 'chatnote err')
    n.appendChild(el('span', '', overText(over)))
    const x = el('button', 'iconbtn', '×')
    x.title = 'Dismiss'
    x.onclick = () => { CHAT.over.delete(id); paintLive() }
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
  // only an agent running on this machine keeps a thread here to open
  const agent = kind === 'Agent' && !/remote/i.test(t.kind)
  head.append(el('span', 'bgkind', kind), el('span', 'shcmd', t.what || 'Running in the background'))
  const out = agent ? null : CHAT.taskOut.get(key)
  // an agent's work reads best as its own thread, steps and all, the way a finished one shows;
  // a command's is what it printed
  const look = el('button', 'btn', agent ? 'Open' : out ? 'Hide output' : 'Output')
  if (agent) look.title = 'Open its steps as a thread'
  look.onclick = () => {
    if (agent) { openAgent(id, t.id); return }
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
    const text = out.loading && !out.output ? 'Loading…' : out.output ||
      (out.failed ? 'Its output could not be read.' : 'Nothing printed yet.')
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
  const box = COMPOSER?.id === id ? COMPOSER : null
  if (e.text) {
    const now = CHAT.drafts.get(id) || ''
    // put in front of what is there now; the chips already in the draft keep their places
    const add = now.trim() ? `${e.text}\n` : e.text
    if (box) {
      if (now.trim()) box.ta.insertBefore(document.createTextNode(add), box.ta.firstChild)
      else box.ta.value = add
    } else {
      const parts = CHAT.layout.get(id)
      if (parts && parts.filter(x => typeof x === 'string').join('') === now) {
        const kept = now.trim() ? parts : parts.filter(x => typeof x !== 'string')
        CHAT.layout.set(id, typeof kept[0] === 'string' ? [add + kept[0], ...kept.slice(1)] : [add, ...kept])
      }
    }
    CHAT.drafts.set(id, now.trim() ? add + now : e.text)
  }
  if (e.pics?.length) CHAT.images.set(id, [...e.pics, ...(CHAT.images.get(id) || [])])
  if (e.docs?.length) CHAT.files.set(id, [...e.docs, ...(CHAT.files.get(id) || [])])
  // left out of the editor's file before: still left out when it is sent again
  if (e.noContext) CHAT.skipCtx.add(id)
  if (box) { box.fit(); paintImages(box); paintGo(box) }
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

// ------------------------------------------------------------ the message box's text
// The box is an editable line of plain text, not a textarea, so a picture or file
// added after the first can sit inside the sentence as a chip, where it was pasted.
// It answers to value, selectionStart/End, setSelectionRange and placeholder the
// way a textarea does, so the rest of this file reads and writes it as before.
// A chip counts as no text at all in those; the message Claude gets has the chips
// taken out (see messageText).

const CHIP_ITEM = new WeakMap()        // chip element -> the picture or file it stands for
const isChip = n => n?.nodeType === 1 && n.classList.contains('cchip')
// A zero-width space after a chip that ends a line gives the caret somewhere to
// sit. Only the ones the box put there are left out of the text (they are kept in
// SPACERS): the same character typed or pasted by you is text like any other
const ZW = '\u200B'
const SPACERS = new WeakSet()
const lead = t => SPACERS.has(t) && t.data.startsWith(ZW) ? 1 : 0
const dataOf = t => t.data.slice(lead(t))

/**
 * What the box holds, in order, as the text counts it: runs of text, line breaks
 * and chips. A <br> that ends its line (the editor's or a line block's last, which
 * the browser adds only to show an empty line) is no character; a line the browser
 * wrapped in its own block starts with one. Every reading of the text goes through
 * this, so offsets and the text always agree.
 */
function pieces (ed) {
  const out = []
  // what came last: nothing yet, text (ending in a typed break or not), or a block's own break
  let last = ''
  let afterBlock = false
  const walk = root => {
    const kids = root.childNodes
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i]
      if (n.nodeType === 3) {
        const text = dataOf(n)
        out.push({ node: n, text, skip: lead(n) })
        if (text) { last = text; afterBlock = false }
      } else if (n.nodeType !== 1) continue
      // a chip is something on the line: a block after it starts a new one
      else if (isChip(n)) { out.push({ node: n, chip: true, text: '' }); last = ' '; afterBlock = false }
      else if (n.nodeName === 'BR') {
        const text = i === kids.length - 1 ? '' : '\n'
        out.push({ node: n, br: true, text })
        if (text) { last = text; afterBlock = false }
      } else {
        // every line block after something starts a new line: after an empty block too
        // (a blank line), but not twice after a break you typed yourself
        if (n.nodeName === 'DIV' && last && (afterBlock || !last.endsWith('\n'))) {
          out.push({ node: n, block: true, text: '\n' })
          last = '\n'
          afterBlock = true
        }
        walk(n)
      }
    }
  }
  walk(ed)
  return out
}

/** The text in the box; a chip is nothing in it. */
const textOf = ed => pieces(ed).map(p => p.text).join('')

/**
 * The text Claude gets: the chips taken out, so "at<chip>please" reads "at please"
 * and "at <chip> please" keeps the spaces you typed. Worked out from the chips
 * themselves, not from any character, so what you typed goes as you typed it.
 */
function messageText (ed) {
  let s = ''
  let gap = false
  for (const p of pieces(ed)) {
    if (p.chip) { gap = true; continue }
    if (!p.text) continue
    // a chip that was the only thing between two words leaves one space; any space or
    // line break you typed around it is kept as it is
    if (gap && s && /\S$/.test(s) && /^\S/.test(p.text)) s += ' '
    gap = false
    s += p.text
  }
  return s
}

/** How far into the text a point in the box is. */
function offsetAt (ed, node, off) {
  const at = document.createRange()
  try { at.setStart(node, off) } catch { return textOf(ed).length }
  let n = 0
  for (const p of pieces(ed)) {
    if (p.node === node && p.node.nodeType === 3) return n + Math.max(0, Math.min(off, p.node.data.length) - p.skip)
    // a piece counts once the point is past its start; a line block's break counts at its very start too
    const where = at.comparePoint(p.node, 0)
    if (where > 0 || (where === 0 && !p.block)) break
    if (p.node.nodeType === 3 && at.comparePoint(p.node, p.node.data.length) > 0) return n
    n += p.text.length
  }
  return n
}

/**
 * The point in the box that far into the text. after: a point right before chips
 * goes past them instead (a chip takes no room in the text, so both are that far in).
 */
function pointAt (ed, n, after = false) {
  for (const p of pieces(ed)) {
    if (p.chip) continue
    if (p.node.nodeType === 3) {
      if (n < p.text.length || (n === p.text.length && !after)) return [p.node, n + p.skip]
      n -= p.text.length
      continue
    }
    if (!p.text) continue
    // at a break: the end of the line before it
    const parent = p.node.parentNode
    if (n === 0) return [parent, [...parent.childNodes].indexOf(p.node)]
    n -= 1
  }
  const last = ed.lastChild
  return last?.nodeName === 'BR' ? [ed, ed.childNodes.length - 1] : [ed, ed.childNodes.length]
}

/** Spacers the box put after a chip go once text follows the chip: they were only there for the caret. */
function dropSpacers (ed) {
  const sel = getSelection()
  for (const p of pieces(ed)) {
    const t = p.node
    if (t.nodeType !== 3 || !p.skip || !p.text) continue
    const at = sel.rangeCount && sel.anchorNode === t ? sel.anchorOffset : -1
    t.deleteData(0, 1)
    SPACERS.delete(t)
    if (at > 0) { const r = document.createRange(); r.setStart(t, at - 1); r.collapse(true); sel.removeAllRanges(); sel.addRange(r) }
  }
}

/** A caret just after what the box holds, before the browser's last <br>. */
function caretToEnd (ed) {
  const sel = getSelection()
  const r = document.createRange()
  const last = ed.lastChild
  if (last?.nodeName === 'BR') r.setStartBefore(last); else r.selectNodeContents(ed)
  r.collapse(last?.nodeName === 'BR')
  sel.removeAllRanges()
  sel.addRange(r)
}

/**
 * Where files being added go: the caret (or the range given), as a live range and
 * as a place in the text, so a box rebuilt meanwhile can find the same spot.
 */
function insertPoint (ed, range = caretRange(ed)) {
  if (!range) return null
  const at = { range, offset: offsetAt(ed, range.startContainer, range.startOffset) }
  POINTS.add(at)
  return at
}
// insertion points whose files may still be on their way, so a box about to be
// replaced can bring their places in the text up to date first (refreshPoints)
const POINTS = new Set()
/**
 * The box is going away (another chat, /clear, chatting turned off): each point in it
 * keeps its place in the text as it is now, edits made since included, for the box
 * that replaces it.
 */
function refreshPoints (c) {
  for (const at of POINTS) {
    if (at.range && c.ta.contains(at.range.startContainer)) {
      at.offset = offsetAt(c.ta, at.range.startContainer, at.range.startOffset)
      at.range = null
    }
    if (!at.range) POINTS.delete(at)
  }
}

/** Where the caret is in the box, as a collapsed range; null when the box does not have it. */
function caretRange (ed) {
  const sel = getSelection()
  if (document.activeElement !== ed || !sel.rangeCount) return null
  const r = sel.getRangeAt(0).cloneRange()
  if (!ed.contains(r.endContainer)) return null
  r.collapse(false)
  return r
}

/** Plain text typed in at the caret, the way the keyboard would, so Undo takes it back. */
function typeIn (ed, text) {
  if (!text) return
  if (document.activeElement !== ed) ed.focus()
  if (!document.execCommand('insertText', false, text)) {
    const r = caretRange(ed)
    if (!r) return
    r.insertNode(document.createTextNode(text))
    r.collapse(false)
    ed.dispatchEvent(new Event('input'))
  }
}

function makeEditor () {
  const ed = el('div', 'cinput')
  // plain text only: a paste or drop of formatted text comes in as its words
  try { ed.contentEditable = 'plaintext-only' } catch {}
  if (ed.contentEditable !== 'plaintext-only') ed.contentEditable = 'true'
  ed.spellcheck = true
  ed.setAttribute('role', 'textbox')
  ed.setAttribute('aria-multiline', 'true')
  ed.setAttribute('aria-label', 'Message')
  const focus = ed.focus
  Object.defineProperties(ed, {
    value: {
      get () { return textOf(ed) },
      // the words are replaced; the chips stay, after them
      set (v) {
        // chips anywhere in the box, inside a line block too
        const chips = [...ed.querySelectorAll('.cchip')]
        ed.replaceChildren(...(String(v) ? [document.createTextNode(String(v))] : []), ...chips)
        if (document.activeElement === ed) this.setSelectionRange(String(v).length, String(v).length)
        ed.classList.toggle('blank', !String(v) && !chips.length)
      },
    },
    selectionStart: { get () { return this.selection().start } },
    selectionEnd: { get () { return this.selection().end } },
    placeholder: {
      get () { return ed.dataset.placeholder || '' },
      set (v) { ed.dataset.placeholder = v; ed.setAttribute('aria-placeholder', v) },
    },
  })
  ed.selection = () => {
    const sel = getSelection()
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) { const n = textOf(ed).length; return { start: n, end: n } }
    const r = sel.getRangeAt(0)
    const a = offsetAt(ed, r.startContainer, r.startOffset)
    return { start: a, end: r.collapsed ? a : offsetAt(ed, r.endContainer, r.endOffset) }
  }
  ed.setSelectionRange = (a, b, afterChips = false) => {
    const r = document.createRange()
    r.setStart(...pointAt(ed, a, afterChips))
    r.setEnd(...pointAt(ed, b))
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  }
  // focus puts the caret at the end, as clicking into a textarea's empty space does
  ed.focus = function () {
    focus.call(ed)
    const sel = getSelection()
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) caretToEnd(ed)
  }
  return ed
}

/**
 * Backspace or Delete right beside a chip takes the chip out whole, with what
 * it stands for. Returns whether one went.
 */
function chipKey (ed, e) {
  if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return false
  const sel = getSelection()
  if (!sel.rangeCount || !sel.isCollapsed || !ed.contains(sel.anchorNode)) return false
  const back = e.key === 'Backspace'
  let node = sel.anchorNode, off = sel.anchorOffset, next
  if (node.nodeType === 3) {
    // only zero-width spaces between the caret and the chip still count as beside it
    if (back ? node.data.slice(lead(node), off) : node.data.slice(Math.max(off, lead(node)))) return false
    next = back ? node.previousSibling : node.nextSibling
  } else next = back ? node.childNodes[off - 1] : node.childNodes[off]
  // an empty text node left between is skipped over
  while (next?.nodeType === 3 && !dataOf(next)) next = back ? next.previousSibling : next.nextSibling
  if (!isChip(next)) return false
  e.preventDefault()
  next.remove()
  ed.dispatchEvent(new Event('input'))
  return true
}

function buildComposer (id) {
  const root = el('div', 'composer')
  const asks = el('div', 'casks')
  // the first picture as a thumbnail on top; every later picture or file is a chip in the text
  const imgs = el('div', 'cimgs')
  const block = el('div', 'cblock')
  const ta = makeEditor()
  ta.value = CHAT.drafts.get(id) || ''
  const slash = el('div', 'cslash')
  slash.hidden = true
  const bar = el('div', 'cbar')
  // one box, as a chat app's reads: the text on top, attach on the left of the row
  // under it, and the model, mode and send button on the right. The reply's status
  // sits with the chat's numbers below the box; model and effort change with /model and /effort
  // the model and effort, and the permission mode: plain words, each opening its own menu
  const model = el('button', 'cpick cmodel')
  model.title = 'Model'
  model.setAttribute('aria-haspopup', 'menu')
  model.setAttribute('aria-expanded', 'false')
  const mode = el('button', 'cpick cmode')
  mode.title = 'Permissions (Shift+Tab)'
  mode.setAttribute('aria-haspopup', 'menu')
  mode.setAttribute('aria-expanded', 'false')
  const status = el('span', 'cstatus')
  const go = el('button', 'cgo')
  // attach a picture, a PDF or a text file
  const clip = el('button', 'cattach')
  clip.appendChild(icon('clip'))
  // the editor gives a drag from Finder or its Explorer to the page only while Shift is held
  clip.title = 'Attach files: pictures, PDFs or text files. You can also paste them, or hold Shift while dragging them onto the chat'
  clip.setAttribute('aria-label', 'Attach files')
  const pickFile = document.createElement('input')
  pickFile.type = 'file'; pickFile.multiple = true; pickFile.hidden = true
  pickFile.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,' + TEXT_EXT.map(x => '.' + x).join(',')
  // where the caret was when you reached for the button: the files go there
  clip.onmousedown = () => { c.insertAt = insertPoint(ta) }
  clip.onclick = () => pickFile.click()
  // closed without a pick: that spot is not kept for a later paste or drop
  pickFile.addEventListener('cancel', () => { POINTS.delete(c.insertAt); c.insertAt = null })
  const right = el('div', 'cright')
  right.append(go)
  bar.append(clip, pickFile, right)
  // what the editor has open goes with the message: said here, and can be left out
  const ctxLine = el('div', 'cctx')
  const live = el('div', 'chatlive')
  const box = el('div', 'cbox')
  box.append(imgs, ta, bar)
  box.onclick = e => { if (e.target === box || e.target === bar || e.target === right) ta.focus() }
  // once, the first time anyone sees the box: what it is and where to turn it off
  const tip = el('div', 'ctip')
  // a usage-limit notice sits just above the box, where you are about to send
  const limit = el('div', 'climit')
  // the line under the box for a chat with no footer yet (a new one): status left, model and mode right
  const under = el('div', 'cunder')
  const underText = el('div', 'fnums')
  const underCtrls = el('div', 'fctrls')
  under.append(underText, underCtrls)
  root.append(limit, asks, block, tip, ctxLine, box, under, slash)
  // chipOf: each later picture or file -> its chip in the text; insertAt: where the next ones go
  const c = { id, root, asks, imgs, block, tip, ta, slash, bar, mode, model, status, go, live, slashAt: 0, ctxLine, mention: null, under, underText, underCtrls, limit,
    chipOf: new Map(), insertAt: null, thumb: null }
  restoreLayout(c)
  pickFile.onchange = () => { addMany(c, [...pickFile.files]); pickFile.value = ''; c.insertAt = null }

  // the box grows with its text up to a height set in the stylesheet; this only
  // says whether it is empty, which shows the placeholder
  const fit = () => ta.classList.toggle('blank', !ta.value && !ta.querySelector('.cchip'))
  c.fit = fit
  ta.oninput = e => {
    // a chip deleted by hand takes its picture or file with it
    if (chipsGone(c)) { paintImages(c); placeLive() }
    // not while a word is being composed (Japanese, Chinese, Korean input): changing the
    // text under the composition breaks it. It is done once the word is in
    if (!e?.isComposing) dropSpacers(ta)
    CHAT.drafts.set(id, ta.value); saveLayout(c); fit(); askMention(c); paintSlash(c); paintGo(c)
  }
  ta.addEventListener('compositionend', () => { dropSpacers(ta); CHAT.drafts.set(id, ta.value); saveLayout(c) })
  ta.onkeydown = e => {
    if (!c.slash.hidden && slashKey(c, e)) return
    if (chipKey(ta, e)) return
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(c); return }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing &&
      recall(c, e.key === 'ArrowUp' ? -1 : 1)) { e.preventDefault(); return }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(c) }
    else if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) {
      // the /mcp card is on top, so Escape closes it first
      if (CHAT.mcp.has(id)) { e.preventDefault(); CHAT.mcp.delete(id); paintLive() }
      // like the terminal: Escape stops a reply in progress
      else if (CHAT.state.get(id)?.busy) { e.preventDefault(); send({ type: 'chatStop', id }) }
      else ta.blur()
    }
  }
  ta.onblur = () => setTimeout(() => { c.slash.hidden = true }, 150)
  ta.onpaste = e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
    e.preventDefault()
    // text comes in as plain words, never as formatting
    if (!files.length) { typeIn(ta, e.clipboardData?.getData('text/plain') || ''); return }
    addMany(c, files, insertPoint(ta))
  }
  // the same rule the button shows: Stop only with nothing to send, files still loading included
  go.onclick = () => { if (CHAT.state.get(id)?.busy && nothingToSend(c)) send({ type: 'chatStop', id }); else submit(c) }
  model.onclick = e => { e.stopPropagation(); pickMenu(c, 'model', model) }
  mode.onclick = e => { e.stopPropagation(); pickMenu(c, 'mode', mode) }
  fit()
  return c
}

// which files can be attached and how big each kind may be: shared with the extension (shared-rules.js)
const TEXT_EXT = sharedRules.TEXT_EXT
// reads under way and /clear moves: see chat-moves.js
const readStart = id => chatMoves.readStart(CHAT, id)
const moveChatState = (id, to) => chatMoves.moveChatState(CHAT, id, to)
/** One picture or file finished reading: once none are left, an Enter that waited for them goes. */
function readDone (slot) {
  try { return readFinished(slot) } finally {
    prunePoints()
    if (COMPOSER?.id === slot.id) paintGo(COMPOSER)
  }
}
/**
 * Insertion points are only needed while files are on their way: once no chat has
 * a read under way, they go (all but the one kept for the attach button's picker).
 */
function prunePoints () {
  if (CHAT.reading.size || CHAT.drops.size) return
  for (const at of POINTS) if (at !== COMPOSER?.insertAt) POINTS.delete(at)
}
function readFinished (slot) {
  // the box may have been rebuilt since (you switched chats and back): send from the current one
  if (chatMoves.readDone(CHAT, slot) && COMPOSER?.id === slot.id) submit(COMPOSER)
}

// where each picture or file read from a paste, drop or the attach button goes in the
// text: the caret at that moment. Kept per item, so reads that finish out of order
// still land where each was put
const PLACE_AT = new WeakMap()

/**
 * Files that could not be attached, all named in one note. An Enter waiting for
 * them does not go without them: the note stays in view and you decide.
 */
function notAttached (id, bad) {
  if (!bad.length) return
  note(id, `Not attached: ${bad.map(([name, why]) => `${name} (${why})`).join(', ')}.`, true)
  callOffSend(id)
}
/**
 * An Enter waiting for files to be read does not go once one of them did not make
 * it (refused, unreadable, or past the 8 and 8): you see what was left out and decide.
 * Every such path comes through here.
 */
const callOffSend = id => CHAT.sendWhenRead.delete(id)

// why a file of this name cannot be attached, or '' when it can: the extension asks the same
const refusal = sharedRules.refusal

/**
 * A picture goes as a picture; a PDF or a text file is attached by name. at: where
 * its chip goes. bad: where a refusal is collected, to be named with the others;
 * without it the refusal is said at once. Returns whether a read started.
 */
function addAny (c, file, at = c.insertAt, bad = null, known = '', batch = newBatch()) {
  const name = file.name || 'pasted picture'
  const refuse = why => {
    const entry = [name, why]
    if (bad) bad.push(entry); else notAttached(c.id, [entry])
    return false
  }
  // .env files usually hold secrets: refused before anything else, a picture type
  // included. A pasted picture has a picture's name (or none) and is not affected
  if (sharedRules.extOf(file.name) === 'env') return refuse('may hold secrets')
  // known: the kind the extension found for a file dropped from the Explorer, which may
  // be a shortcut whose own name says less than the file it leads to (checked there).
  // Otherwise a picture type is a picture (a pasted one has no useful name), and
  // anything else goes by its name, the same wherever it came from
  let kind = known
  if (!kind && file.type.startsWith('image/')) kind = 'picture'
  if (!kind) {
    const why = refusal(file.name)
    if (why) return refuse(why)
    kind = sharedRules.kindOf(file.name)
  }
  // a picture named as one but given no type (some Finder drops): typed from its name
  const type = kind !== 'picture' ? '' : file.type.startsWith('image/') ? file.type : sharedRules.mediaTypeOf(file.name)
  if (kind === 'picture' && !/^image\/(png|jpeg|gif|webp)$/.test(type)) return refuse('only PNG, JPEG, GIF and WebP pictures can be sent')
  if (file.size > sharedRules.LIMITS[kind]) return refuse(`too big, ${sharedRules.LIMIT_WORDS[kind]} at most`)
  // an empty PDF has nothing to send, and the whole message would be refused for it
  if (kind === 'pdf' && !file.size) return refuse('empty')
  const typed = kind === 'picture' && file.type !== type ? new File([file], file.name, { type }) : file
  admit(batch, { slot: readStart(c.id), file: typed, kind, name, at })
  return true
}

/**
 * Files from one attach, paste or drop are added in the order they were given,
 * however their reads finish, and only as many are read at once as IN_FLIGHT:
 * the rest wait their turn, so a big selection is never all held in memory. Each
 * counts as a read under way from the start (an Enter waits for it). Before a read
 * starts, the message's room is checked: one past the 8 pictures or 8 files is named
 * as left out instead, and the next one in line can take a slot that frees up.
 */
const IN_FLIGHT = 3
const newBatch = () => ({ queue: [], waiting: [], active: 0, pending: { pictures: 0, files: 0 } })
function takeTurn (batch) { const turn = { then: null }; batch.queue.push(turn); return turn }
function inTurn (batch, turn, then) {
  turn.then = then
  while (batch.queue[0]?.then) batch.queue.shift().then()
}
function admit (batch, job) {
  batch.waiting.push(job)
  pump(batch)
  // a file loading counts as something to send: the button shows Queue, not Stop
  if (COMPOSER?.id === job.slot.id) paintGo(COMPOSER)
}
function pump (batch) {
  while (batch.active < IN_FLIGHT && batch.waiting.length) {
    const job = batch.waiting[0]
    const bucket = job.kind === 'picture' ? 'pictures' : 'files'
    const have = ((bucket === 'pictures' ? CHAT.images : CHAT.files).get(job.slot.id) || []).length
    // full only counts what is attached: with reads still on their way that would fill
    // it, the next waits for them (one may fail and leave room) instead of being refused
    if (have < 8 && have + batch.pending[bucket] >= 8) break
    batch.waiting.shift()
    if (have >= 8) { overLimit(job.slot.id, job.name, bucket); readDone(job.slot); continue }
    batch.active++
    batch.pending[bucket]++
    startRead(batch, job, () => { batch.active--; batch.pending[bucket]--; pump(batch) })
  }
}
/** One file read and, in its turn, added to the message and the text. finish frees its place in the batch. */
function startRead (batch, job, finish) {
  const { slot, file, kind, at, name } = job
  const bucket = kind === 'picture' ? 'pictures' : 'files'
  const turn = takeTurn(batch)
  const r = new FileReader()
  const fail = () => { notAttached(slot.id, [[name, 'could not be read']]); finish(); readDone(slot) }
  r.onerror = () => inTurn(batch, turn, fail)
  r.onload = () => inTurn(batch, turn, () => {
    const id = slot.id               // the chat may have moved to a new id while this was read
    let item
    if (kind === 'picture') {
      const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(r.result))
      if (!m) return fail()
      // the name and size are for the chip only: submit sends the type and data alone
      item = { mediaType: m[1], data: m[2], url: String(r.result), name: file.name || '', size: file.size }
    } else {
      item = { name: file.name, mediaType: kind === 'pdf' ? 'application/pdf' : 'text/plain' }
      if (kind === 'pdf') item.data = String(r.result).replace(/^data:[^,]*,/, '')
      else item.text = String(r.result)
    }
    if (at) PLACE_AT.set(item, at)
    // a message carries at most 8 of each: one past that is named, not dropped quietly
    if (chatMoves.readPlace(CHAT, slot, bucket, item) === 'over') overLimit(id, name, bucket)
    if (COMPOSER?.id === id) { paintImages(COMPOSER); paintGo(COMPOSER) }
    // its place goes to the next in line first; then this read counts as done
    finish()
    readDone(slot)
  })
  if (kind === 'text') r.readAsText(file); else r.readAsDataURL(file)
}

/** Several files from one attach, paste or drop: each read as usual, in order, the refusals named together. */
function addMany (c, files, at = c.insertAt) {
  const bad = []
  const batch = newBatch()
  for (const f of files) addAny(c, f, at, bad, '', batch)
  notAttached(c.id, bad)
}

// ------------------------------------------------------------ dropping files in

/** The file links a drop carries, from whichever of VS Code's and the system's lists it has. */
function dropUris (dt) {
  const out = []
  const lines = t => String(t || '').split(/\r?\n/)
  out.push(...lines(dt.getData('application/vnd.code.uri-list')))
  try { const r = JSON.parse(dt.getData('resourceurls') || '[]'); if (Array.isArray(r)) out.push(...r) } catch {}
  out.push(...lines(dt.getData('text/uri-list')))
  return [...new Set(out.map(x => String(x).trim()).filter(x => x && !x.startsWith('#')))]
}
const uriName = u => {
  const last = String(u).replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() || String(u)
  try { return decodeURIComponent(last) } catch { return last }
}

/**
 * Files dropped on the box go the same way as ones attached or pasted. A drop from
 * VS Code's Explorer carries only links, so the extension reads those files and
 * hands them back; the same checks and the 8 and 8 limit then apply.
 */
function dropIn (c, dt) {
  const files = [...(dt.files || [])]
  if (files.length) { addMany(c, files); return }
  // links to files: on this computer they are read by the extension; anywhere else
  // (a remote window's files) it says why not. Web addresses are not files
  const uris = dropUris(dt).filter(u => !/^(https?|mailto|data):/i.test(u))
  // no file at all (some text): the words go into the box, as a plain drop would put them
  if (!uris.length) {
    typeIn(c.ta, dt.getData('text/plain'))
    return
  }
  const bad = []
  const want = []
  for (const u of uris) {
    const name = uriName(u)
    const why = refusal(name)
    if (why) bad.push([name, why])
    else if (want.length >= 16) bad.push([name, 'one drop takes 16 files at most'])
    else want.push(u)
  }
  if (!want.length) { notAttached(c.id, bad); return }
  // counted as a read under way, so an Enter pressed meanwhile waits for these files;
  // what was refused here is named with what the extension refuses, in one note
  const slot = readStart(c.id)
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  CHAT.drops.set(key, { slot, at: c.insertAt, bad })
  // what the box still has room for, so the extension reads (and sends back) no more than fits
  const room = { pictures: 8 - (CHAT.images.get(c.id) || []).length, files: 8 - (CHAT.files.get(c.id) || []).length }
  send({ type: 'chatDropRead', key, uris: want, room })
}
// ------------------------------------------------------------ dropping anywhere on the chat

// a drag that carries files (from Finder, VS Code's Explorer or a tab), not a text selection or a link
const FILE_DRAG = ['files', 'application/vnd.code.uri-list', 'resourceurls']
const carriesFiles = e => [...(e.dataTransfer?.types || [])].some(t => FILE_DRAG.includes(String(t).toLowerCase()))
/** A box that can take attachments is on screen: a chat you can talk to here, not blocked. */
// and only while the Chats page is the one up: a box under a page in the background takes nothing
const dropBox = () => TAB === 'chats' && COMPOSER && COMPOSER.root.isConnected && chatTarget()?.id === COMPOSER.id && !COMPOSER.ta.parentNode.hidden ? COMPOSER : null
const DROP = { depth: 0, cover: null, quiet: null }
/** While files are dragged over the chat, the whole panel says where they go. */
function dropCover (on) {
  if (!DROP.cover) {
    const cover = el('div', 'dropcover')
    cover.setAttribute('aria-hidden', 'true')
    const pill = el('div', 'droppill')
    const words = el('div', 'droptext')
    // VS Code hands a drop from Finder or its Explorer to the page only while Shift is held
    words.append(el('b', '', 'Drop files to attach'), el('span', '', 'Keep holding Shift while you drop'))
    pill.append(icon('clip', 'dropico'), words)
    cover.appendChild(pill)
    cover.hidden = true
    document.body.appendChild(cover)
    DROP.cover = cover
  }
  DROP.cover.hidden = !on
  clearTimeout(DROP.quiet)
  if (!on) DROP.depth = 0
}
document.addEventListener('dragenter', e => {
  if (!carriesFiles(e) || !dropBox()) return
  e.preventDefault()
  DROP.depth++
  dropCover(true)
})
document.addEventListener('dragover', e => {
  if (!carriesFiles(e) || !dropBox()) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  if (DROP.cover?.hidden) { DROP.depth = Math.max(DROP.depth, 1); dropCover(true) }
  // a drag over the page sends this many times a second. When they stop with no
  // leave or drop (Shift let go, so the editor took the drag back), the cover goes
  clearTimeout(DROP.quiet)
  DROP.quiet = setTimeout(() => dropCover(false), 400)
})
document.addEventListener('dragleave', e => {
  if (!DROP.depth) return
  // out of the window altogether, or the last element left: the cover goes
  const out = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
  if (out || --DROP.depth <= 0) dropCover(false)
})
document.addEventListener('dragend', () => dropCover(false))
window.addEventListener('blur', () => dropCover(false))
document.addEventListener('keydown', e => { if (e.key === 'Escape' && DROP.depth) dropCover(false) })
document.addEventListener('drop', e => {
  dropCover(false)
  const c = dropBox()
  if (!c || !carriesFiles(e)) return
  e.preventDefault()
  // dropped on the text: where it landed; anywhere else: at the caret if the box had it, else at the end
  const at = document.caretRangeFromPoint?.(e.clientX, e.clientY)
  c.insertAt = at && c.ta.contains(at.startContainer) ? insertPoint(c.ta, at) : insertPoint(c.ta)
  dropIn(c, e.dataTransfer)
  c.insertAt = null
})

/** The extension read the dropped files: each goes through the same checks as an attached one. */
function dropRead (m) {
  const { slot, at, bad = [], retried = false } = CHAT.drops.get(m.key) || {}
  if (!slot) return
  CHAT.drops.delete(m.key)
  const full = []
  const taken = { picture: 0, file: 0 }
  const batch = newBatch()             // added in the order they were dropped
  for (const it of Array.isArray(m.items) ? m.items : []) {
    const name = String(it?.name || 'file')
    if (it?.full && typeof it.uri === 'string') { full.push(it); continue }
    if (it?.error || typeof it?.data !== 'string') { bad.push([name, String(it?.error || 'could not be read')]); continue }
    let bin
    try { bin = atob(it.data) } catch { bad.push([name, 'could not be read']); continue }
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    // read as what the extension found the file to be, shown under the name it was dropped as;
    // into the chat the read belongs to now (/clear may have moved it to a new id)
    const known = ['picture', 'pdf', 'text'].includes(it.kind) ? it.kind : ''
    const type = known === 'picture' ? String(it.mediaType || '') : known === 'pdf' ? 'application/pdf' : 'text/plain'
    if (!known || (known === 'picture' && !/^image\/(png|jpeg|gif|webp)$/.test(type))) { bad.push([name, 'could not be read']); continue }
    if (addAny({ id: slot.id }, new File([bytes], name, { type }), at, bad, known, batch)) taken[known === 'picture' ? 'picture' : 'file']++
  }
  // files there was no room for when the drop was sent: room may have opened since
  // (an attachment removed), so they are asked for once more, with the room there is now
  const room = {
    pictures: 8 - (CHAT.images.get(slot.id) || []).length - taken.picture,
    files: 8 - (CHAT.files.get(slot.id) || []).length - taken.file,
  }
  const again = retried ? [] : full.filter(it => (it.kind === 'picture' ? room.pictures : room.files) > 0)
  for (const it of full) if (!again.includes(it)) bad.push([String(it.name || 'file'), String(it.error)])
  if (again.length) {
    const next = readStart(slot.id)
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    CHAT.drops.set(key, { slot: next, at, bad, retried: true })
    send({ type: 'chatDropRead', key, uris: again.map(it => it.uri), room })
    readDone(slot)
    return
  }
  // said before this read counts as done, so a waiting Enter is called off rather than sent
  notAttached(slot.id, bad)
  readDone(slot)
}

/** "112 KB", the way a file list says it. */
function sizeText (n) {
  if (!(n > 0)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
// a file's size, worked out once from what is attached: nothing extra is kept on
// the file itself, as the file goes to Claude exactly as it is
const FILE_SIZE = new WeakMap()
function fileSize (f) {
  if (!FILE_SIZE.has(f)) {
    FILE_SIZE.set(f, f.data ? Math.floor(f.data.replace(/=+$/, '').length * 3 / 4)
      : new TextEncoder().encode(f.text || '').length)
  }
  return FILE_SIZE.get(f)
}

/** Take a picture or file out of what goes with the message. */
function dropItem (id, item) {
  for (const [kind, map] of [['pictures', CHAT.images], ['files', CHAT.files]]) {
    const list = map.get(id) || []
    const i = list.indexOf(item)
    if (i >= 0) { list.splice(i, 1); clearOver(id, kind); return true }
  }
  return false
}

/** Chips deleted from the text by hand: their pictures and files go too. Returns whether any did. */
function chipsGone (c) {
  let gone = false
  for (const [item, chip] of c.chipOf) {
    if (c.ta.contains(chip)) continue
    c.chipOf.delete(item)
    if (dropItem(c.id, item)) gone = true
  }
  return gone
}

/** The pictures and files in the order they stand in the text: the thumbnail first, then each chip. */
function inTextOrder (c) {
  const pics = CHAT.images.get(c.id) || []
  const files = CHAT.files.get(c.id) || []
  const seen = [...c.ta.querySelectorAll('.cchip')].map(ch => CHIP_ITEM.get(ch)).filter(Boolean)
  // anything without a chip (there should be none) keeps its place after the rest
  const order = list => [...seen.filter(x => list.includes(x)), ...list.filter(x => !seen.includes(x))]
  return { pics: pics.length ? [pics[0], ...order(pics.slice(1))] : [], files: order(files) }
}

function chipFor (c, item, picture) {
  const name = picture ? item.name || 'pasted picture' : item.name
  const chip = el('span', 'cchip')
  chip.contentEditable = 'false'
  if (picture) {
    const img = el('img', 'cchipimg')
    img.src = item.url
    img.alt = ''
    chip.appendChild(img)
  } else chip.appendChild(icon('file', 'cchipico'))
  chip.append(el('span', 'cchipname', name), el('span', 'cchipsize', sizeText(picture ? item.size : fileSize(item))))
  const x = el('button', 'cimgx', '×')
  x.title = `Remove ${name}`
  x.setAttribute('aria-label', `Remove ${name}`)
  // the caret stays where it was in the text
  x.onmousedown = e => e.preventDefault()
  x.onclick = e => { e.stopPropagation(); if (dropItem(c.id, item)) { paintImages(c); paintGo(c); placeLive() } }
  chip.appendChild(x)
  chip.title = picture ? name : `${name} (${item.mediaType === 'application/pdf' ? 'PDF' : 'text file'})`
  CHIP_ITEM.set(chip, item)
  return chip
}

/** A new chip goes where the caret was when it was pasted, dropped or attached; otherwise at the end. */
function placeChip (c, chip, at) {
  const ed = c.ta
  const sel = getSelection()
  let r = at?.range
  // the box was rebuilt since (you left the chat and came back): the same place in
  // the text, worked out again in the new box
  if (at && !(r && ed.contains(r.startContainer)) && Number.isFinite(at.offset)) {
    r = document.createRange()
    r.setStart(...pointAt(ed, at.offset))
    r.collapse(true)
    at.range = r
    POINTS.add(at)
  }
  const placed = !!r && ed.contains(r.startContainer)
  // the caret follows the chip only if it is still where the file was added: a
  // caret or selection you have moved since is left alone
  const caretThere = placed && document.activeElement === ed && sel.rangeCount && sel.isCollapsed &&
    sel.getRangeAt(0).compareBoundaryPoints(Range.START_TO_START, r) === 0
  if (placed) r.insertNode(chip)
  else {
    const last = ed.lastChild
    if (last?.nodeName === 'BR') ed.insertBefore(chip, last); else ed.appendChild(chip)
  }
  // nothing is added after the chip: what you type next decides the spacing. Only a chip
  // with no text after it gets a zero-width space, so the caret can sit after it
  let after = chip.nextSibling
  if (after?.nodeType !== 3) { after = document.createTextNode(ZW); SPACERS.add(after); chip.after(after) }
  if (!placed) return
  // the next file from the same paste or drop goes after this one
  r.setStart(after, lead(after))
  r.collapse(true)
  if (caretThere) { sel.removeAllRanges(); sel.addRange(r.cloneRange()) }
}

/**
 * The draft as it stands in the box: runs of text with the pictures and files in
 * between, kept with the chat so its chips come back where they were when you
 * come back to it.
 */
function saveLayout (c) {
  const parts = []
  for (const p of pieces(c.ta)) {
    if (p.chip) { const item = CHIP_ITEM.get(p.node); if (item) parts.push(item); continue }
    if (!p.text) continue
    if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += p.text
    else parts.push(p.text)
  }
  CHAT.layout.set(c.id, parts)
}
/**
 * A rebuilt box puts the saved draft back as it was. Only when that saved draft is
 * still the draft: anything that rewrote the text since (a message given back, a
 * command) wins, and its chips go at the end as before.
 */
function restoreLayout (c) {
  const parts = CHAT.layout.get(c.id)
  if (!parts || parts.filter(x => typeof x === 'string').join('') !== (CHAT.drafts.get(c.id) || '')) return
  const pics = CHAT.images.get(c.id) || []
  const files = CHAT.files.get(c.id) || []
  const nodes = []
  for (const x of parts) {
    if (typeof x === 'string') { nodes.push(document.createTextNode(x)); continue }
    // only what is still attached, and not the picture shown as the thumbnail
    if (!(pics.includes(x) && x !== pics[0]) && !files.includes(x)) continue
    const chip = chipFor(c, x, pics.includes(x))
    c.chipOf.set(x, chip)
    nodes.push(chip)
    if (typeof parts[parts.indexOf(x) + 1] !== 'string') { const z = document.createTextNode(ZW); SPACERS.add(z); nodes.push(z) }
  }
  c.ta.replaceChildren(...nodes)
}

/**
 * The first picture as a thumbnail on top, every later picture and file as a chip
 * in the text. Only what changed is touched: the text, the caret and Undo stay.
 */
function paintImages (c) {
  chipsGone(c)
  const list = CHAT.images.get(c.id) || []
  const files = CHAT.files.get(c.id) || []
  const first = list[0] || null
  if (c.thumb !== first || (first && !c.imgs.firstChild)) {
    c.thumb = first
    c.imgs.replaceChildren()
    if (first) {
      const name = first.name || 'pasted picture'
      const tile = el('div', 'cimg')
      const img = el('img')
      img.src = first.url
      img.alt = name
      tile.title = name
      const x = el('button', 'cimgx', '×')
      x.title = `Remove ${name}`
      x.setAttribute('aria-label', `Remove ${name}`)
      x.onclick = e => { e.stopPropagation(); if (dropItem(c.id, first)) { paintImages(c); paintGo(c); placeLive() } }
      tile.append(img, x)
      c.imgs.appendChild(tile)
    }
  }
  c.imgs.hidden = !first
  const want = new Set([...list.slice(1), ...files])
  // a chip whose picture or file went (sent, removed, or now the thumbnail) leaves the text
  for (const ch of [...c.ta.querySelectorAll('.cchip')]) {
    const item = CHIP_ITEM.get(ch)
    if (want.has(item) && c.chipOf.get(item) === ch) continue
    if (c.chipOf.get(item) === ch) c.chipOf.delete(item)
    ch.remove()
  }
  for (const item of want) {
    if (c.chipOf.has(item)) continue
    const chip = chipFor(c, item, list.includes(item))
    c.chipOf.set(item, chip)
    placeChip(c, chip, PLACE_AT.get(item))
    // used once: a chip put back later (a message given back) goes to the end, not to an old spot
    PLACE_AT.delete(item)
  }
  c.fit?.()
  saveLayout(c)
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
  // typed over the letters after "@", so chips elsewhere in the text stay where they are:
  // the start is taken after any chip right before the "@", so the chip is not typed over
  c.ta.focus()
  c.ta.setSelectionRange(at, end, true)
  typeIn(c.ta, '@' + x.name + ' ')
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
  // the words with the chips taken out; the pictures and files in the order their chips stand
  const text = only ? only.text : messageText(c.ta)
  const order = only ? { pics: [], files: [] } : inTextOrder(c)
  const images = order.pics
  const files = order.files
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
    // the command has gone: it does not come back as the draft when you return to this chat
    CHAT.drafts.delete(id)
    CHAT.layout.delete(id)
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
  // what was left out stays in view through the send it was left out of, then goes;
  // a message the logbook sends itself carries no attachments and leaves it be
  const over = CHAT.over.get(id)
  if (over && !only) { if (over.sent) CHAT.over.delete(id); else over.sent = true }
  CHAT.notes.delete(id)
  CHAT.done.delete(id)
  const st = CHAT.state.get(id) || { id, asks: [] }
  if (!st.busy) CHAT.busySince.set(id, Date.now())
  CHAT.state.set(id, { ...st, busy: true, sentHere: Date.now() })
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

/**
 * Past the 8 pictures and 8 files a message carries: every one left out is
 * named in one note, both kinds together. Pasted pictures share one name, so
 * they are counted instead.
 */
function overLimit (id, name, kind) {
  // a list from a message already sent is not added to: this message starts its own
  const prev = CHAT.over.get(id)
  const over = prev && !prev.sent ? prev : { pictures: [], files: [] }
  over[kind] = [...over[kind], name]
  CHAT.over.set(id, over)
  callOffSend(id)
  if (COMPOSER?.id === id) placeLive()
}
function overText (over) {
  const say = (k, list) => {
    if (!list.length) return ''
    const counts = new Map()
    for (const n of list) counts.set(n, (counts.get(n) || 0) + 1)
    return `${k}: ` + [...counts].map(([n, x]) => x > 1 ? `${n} (${x})` : n).join(', ')
  }
  const parts = [say('pictures', over.pictures), say('files', over.files)].filter(Boolean)
  return `Not added, a message carries at most 8 pictures and 8 files. ${parts.join('; ')}`
}
/** Removing a picture makes room for pictures, a file for files: only that kind's list goes. */
function clearOver (id, kind) {
  const over = CHAT.over.get(id)
  if (!over || over.sent) return
  over[kind] = []
  if (!over.pictures.length && !over.files.length) CHAT.over.delete(id)
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
    // one line, at most one filled button: other ways on are quiet links, and a copy
    // of the chat is in the chat's menu (Continue here as a copy)
    c.block.appendChild(el('span', '', place || 'Running elsewhere. Reply there, or continue here as a copy from the chat\'s menu.'))
    if (w?.where === 'terminal') {
      const show = el('button', 'linkbtn', 'Show terminal')
      show.title = 'Bring that terminal to the front'
      show.onclick = () => send({ type: 'chatShow', id })
      c.block.appendChild(show)
    }
    // idle there, waiting for a message: it can be let go there and carried on here
    if (idle) {
      const take = el('button', 'btn pri', 'Continue here')
      take.title = w?.where === 'terminal' ? 'Stops it in the terminal and continues the chat here; nothing it wrote is lost'
        : 'Stops it there and continues the chat here; nothing it wrote is lost'
      take.onclick = () => { take.disabled = true; take.textContent = 'Stopping…'; send({ type: 'chatTakeover', id, idle: true }) }
      c.block.appendChild(take)
    }
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
    const x = el('button', 'linkbtn', 'Dismiss')
    x.onclick = () => { CHAT.cutoff.delete(id); send({ type: 'chatCutoffClear', id }); paintComposer() }
    c.block.append(go, x)
  }
  const now = CHAT.state.get(id)
  c.ta.placeholder = now?.asks?.length ? 'Answer Claude above first'
    : now?.busy ? 'Queue a message…'
    : where === 'here' || CHAT.here.has(id) ? 'Message Claude… (/ for commands, ! for a shell command)'
      : 'Continue here… (/ for commands, ! for a shell command)'
  paintTip(c)
  paintLimit(c)
  paintCtx(c)
  // a chat running here shows its status under the reply, not the walking figure:
  // the room kept for that figure under the last message is not needed
  $('#detail')?.classList.toggle('runhere', where === 'here' || CHAT.here.has(id))
  paintPickers(c)
  paintAsks(c)
  paintImages(c)
  paintGo(c)
  paintStatus(c)
}

/** The usage-limit notice above the box: one for every view, dismissed for all of them at once. */
function paintLimit (c) {
  const n = LIMIT_NOTICE
  // redrawn when the notice changes, and when the day does (a reset "on Monday" becomes "at 9:00")
  const sig = n ? `${n.kind}|${n.status}|${n.resetsAt}|${new Date().toDateString()}` : ''
  if (c.limit.dataset.sig === sig) return
  c.limit.dataset.sig = sig
  // at midnight the day label is worked out again ("on Mon" becomes "at 9:00"); no notice, no timer
  clearTimeout(c.limitMidnight)
  if (n) {
    const mid = new Date()
    mid.setHours(24, 0, 1, 0)
    c.limitMidnight = setTimeout(() => { if (c.limit.isConnected) paintLimit(c) }, mid - Date.now())
  }
  c.limit.replaceChildren()
  c.limit.hidden = !n
  if (!n) return
  // the time alone for a reset today; on another day the day and date too
  const at = n.resetsAt ? new Date(n.resetsAt * 1000) : null
  const time = at ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  const reset = !at ? ''
    : at.toDateString() === new Date().toDateString() ? ` It resets at ${time}.`
      : ` It resets on ${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}.`
  const which = { five_hour: 'five-hour', seven_day: 'weekly', seven_day_opus: 'weekly', seven_day_sonnet: 'weekly' }[n.kind] || ''
  const hit = n.status === 'rejected'
  c.limit.className = 'climit chatnote' + (hit ? ' err' : '')
  c.limit.appendChild(el('span', '', hit
    ? `You've hit your ${which ? which + ' ' : ''}usage limit.${reset}`
    : `You're close to your ${which ? which + ' ' : ''}usage limit.${reset}`))
  const x = el('button', 'iconbtn', '×')
  x.title = 'Hide for now, in every chat. It comes back sooner if you are using it up quickly, and at once if you reach the limit'
  x.setAttribute('aria-label', 'Hide the usage-limit notice for now')
  // the notice as shown: if a newer one has arrived meanwhile, the extension keeps that one up
  x.onclick = () => send({ type: 'limitDismiss', kind: n.kind, status: n.status, resetsAt: n.resetsAt })
  c.limit.appendChild(x)
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

/** Nothing typed, attached, or still being read: what makes the button Stop while Claude works. */
const nothingToSend = c => !c.ta.value.trim() && !(CHAT.images.get(c.id) || []).length && !(CHAT.files.get(c.id) || []).length &&
  !CHAT.reading.get(c.id)

function paintGo (c) {
  const st = CHAT.state.get(c.id)
  const empty = nothingToSend(c)
  // "!" switches the box to a shell command, as Claude Code's terminal does: it looks it
  const shell = /^\s*!/.test(c.ta.value) && !(CHAT.images.get(c.id) || []).length
  c.ta.parentNode.classList.toggle('shell', shell)
  c.ta.parentNode.dataset.mode = shell ? 'Shell command · runs in the chat\'s folder' : ''
  if (shell) {
    c.go.replaceChildren(icon('play'))
    c.go.classList.remove('stop', 'queue')
    c.go.title = 'Run (Enter)'
    c.go.setAttribute('aria-label', 'Run')
    c.go.disabled = !c.ta.value.replace(/^\s*!/, '').trim()
    return
  }
  // one button: Stop with nothing typed while Claude works, Queue with something
  // typed, Send otherwise. Escape stops the reply whichever it shows
  const busy = !!st?.busy
  const stop = busy && empty
  const say = stop ? 'Stop' : busy ? 'Queue this message (sent when Claude finishes)' : 'Send'
  c.go.replaceChildren(stop ? el('span', 'cstopico') : icon(busy ? 'queue' : 'send'))
  c.go.classList.toggle('stop', stop)
  c.go.classList.toggle('queue', busy && !stop)
  c.go.title = stop ? 'Stop (Escape)' : `${say} (Enter)`
  c.go.setAttribute('aria-label', say)
  c.go.disabled = !stop && empty
}

function paintStatus (c) {
  const st = CHAT.state.get(c.id)
  const done = CHAT.done.get(c.id)
  c.status.textContent = st?.asks?.length ? 'Waiting for you'
    : st?.busy || st?.bg?.length ? ''
      // "Done in" only when Settings > Footer has Reply time on
      : done && Date.now() - done.at < 60000 && done.ms && footOn('replyTime') ? `Done in ${secs(done.ms)}` : ''
}

const secs = ms => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's'

const capWord = w => w ? w[0].toUpperCase() + w.slice(1) : ''
/** The modes on offer; the one Claude is in shows even when no longer offered (bypass, after the setting went off). */
function modeList (p) {
  const list = modes()
  return list.some(m => m[0] === p.mode) || p.mode !== BYPASS[0] ? list : [...list, BYPASS]
}

function paintPickers (c) {
  const p = picksFor(c.id)
  const st = CHAT.state.get(c.id)
  // once Claude is running, what it reports wins (plan approval switches the mode),
  // except while a pick of yours waits for its answer
  if (st?.running && st.mode && !p.modeAsk) p.mode = st.mode
  const list = modeList(p)
  const label = (list.find(m => m[0] === p.mode) || list[0])[1]
  if (c.mode.textContent !== label) {
    c.mode.textContent = label
    c.mode.setAttribute('aria-label', `Permission mode: ${label}`)
  }
  // the model, then its effort in a quieter colour; Claude's default until one is picked
  const name = p.model ? modelName(p.model) : 'Default model'
  const effort = capWord(p.effort)
  const sig = name + '|' + effort
  if (c.model.dataset.sig !== sig) {
    c.model.dataset.sig = sig
    c.model.replaceChildren(el('span', '', name))
    if (effort) c.model.appendChild(el('span', 'ceffort', effort))
    c.model.setAttribute('aria-label', `Model: ${name}${effort ? `, effort ${effort}` : ''}`)
  }
}

// ------------------------------------------------------------ model and mode menus

/** A model's family and version from its name ("Opus 5.5" -> opus, [5, 5]). */
function familyOf (m) {
  const name = String(m.label || modelName(m.value)).replace(/\s*\(1M\)$/i, '')
  const v = /^(.*?)\s*(\d+(?:\.\d+)*)\s*$/.exec(name)
  return v ? { fam: v[1].trim().toLowerCase(), ver: v[2].split('.').map(Number) } : { fam: name.toLowerCase(), ver: [] }
}
const newerThan = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0 }
  return false
}
const modelKey = v => String(modelName(v) || '').replace(/\s*\(1M\)$/i, '').toLowerCase()
/** Whether this entry is the model the chat is on: the same id, or the same name ("opus[1m]" is Opus). */
const isPicked = (m, picked) => !!picked && (m.value === picked || modelKey(m.value) === modelKey(picked) ||
  String(m.label || '').toLowerCase() === modelKey(picked))
/**
 * The newest of each family at the top, the rest under More models. The model the
 * chat is on stays at the top even when it is an older one, so the choice is in view.
 */
function splitModels (list, picked) {
  const best = new Map()
  for (const m of list) {
    const f = familyOf(m)
    const b = best.get(f.fam)
    if (!b || newerThan(f.ver, familyOf(b).ver)) best.set(f.fam, m)
  }
  const top = list.filter(m => best.get(familyOf(m).fam) === m)
  const rest = list.filter(m => !top.includes(m))
  const old = rest.find(m => isPicked(m, picked))
  return { top: old ? [...top, old] : top, rest }
}

let PICK_SHUT = { kind: '', at: 0 }
/**
 * The menu over the model or the mode: the same choices /model, /effort and
 * Shift+Tab give. The chosen row carries a tick. Effort and older models open
 * beside it, or in its place when there is no room. Arrows move, Right and Left
 * open and close the side menus, Escape closes.
 */
function pickMenu (c, kind, anchor) {
  // the click on its own control that just closed this menu does not open it again
  if (PICK_SHUT.kind === kind && Date.now() - PICK_SHUT.at < 400) return
  document.querySelectorAll('body > .pickwrap').forEach(m => m.remove())
  for (const b of c.root.querySelectorAll('.cpick[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false')
  const p = picksFor(c.id)
  // the panels share one holder, so a click in either one is inside the menu
  const wrap = el('div', 'pickwrap')
  const panel = () => { const m = el('div', 'menu pickmenu'); m.setAttribute('role', 'menu'); wrap.appendChild(m); return m }
  const main = panel()
  let sub = null
  const row = (into, label, opts = {}) => {
    const b = el('button', 'menuitem')
    b.tabIndex = -1
    b.setAttribute('role', opts.sub ? 'menuitem' : 'menuitemradio')
    b.appendChild(el('span', '', label))
    const right = el('span', 'mright')
    if (opts.value) right.appendChild(el('em', '', opts.value))
    if (opts.sub) {
      b.dataset.sub = opts.sub
      b.setAttribute('aria-haspopup', 'menu')
      b.setAttribute('aria-expanded', 'false')
      right.appendChild(icon('chevron', 'mchev'))
    } else {
      b.setAttribute('aria-checked', String(!!opts.on))
      // the tick says which one is chosen; the hover colour only says where the pointer is
      const tick = icon('check', 'mtick')
      tick.style.visibility = opts.on ? 'visible' : 'hidden'
      right.appendChild(tick)
    }
    b.appendChild(right)
    if (opts.tip) b.title = opts.tip
    b.onclick = e => {
      e.stopPropagation()
      if (opts.sub) { openSub(opts.sub, b); return }
      kill(); opts.pick(); c.ta.focus()
    }
    into.appendChild(b)
    return b
  }
  const sep = into => { const d = el('div', 'menusep'); d.setAttribute('role', 'separator'); into.appendChild(d) }
  const models = chatModels()
  const split = splitModels(models, p.model)

  function fill (m, what) {
    if (what === 'effort') {
      m.appendChild(el('div', 'pnote', 'Higher effort means more thorough responses, but takes longer and uses your limits faster.'))
      for (const l of effortLevels(c.id)) row(m, capWord(l), { on: l === p.effort, pick: () => setPick(c, 'effort', l) })
    } else if (what === 'more') {
      for (const x of split.rest) row(m, x.label || x.value, { on: isPicked(x, p.model), tip: x.note, pick: () => setPick(c, 'model', x.value) })
    }
  }
  function closeSub (focusRow) {
    if (!sub) return
    const from = main.querySelector(`.menuitem[data-sub="${sub.dataset.what}"]`)
    from?.setAttribute('aria-expanded', 'false')
    sub.remove()
    sub = null
    main.hidden = false
    if (focusRow) from?.focus()
  }
  function openSub (what, from) {
    const again = sub?.dataset.what === what
    closeSub(false)
    if (again) return
    sub = panel()
    sub.dataset.what = what
    sub.classList.add('pickside')
    from.setAttribute('aria-expanded', 'true')
    const r = main.getBoundingClientRect()
    fill(sub, what)
    // never taller than the window: it scrolls inside instead
    sub.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`
    const w = sub.getBoundingClientRect().width
    const h = sub.getBoundingClientRect().height
    const f = from.getBoundingClientRect()
    const top = Math.max(8, Math.min(f.top - 6, window.innerHeight - h - 8))
    if (r.left - w - 6 >= 8) { sub.style.left = `${r.left - w - 6}px`; sub.style.top = `${top}px` }
    else if (r.right + 6 + w <= window.innerWidth - 8) { sub.style.left = `${r.right + 6}px`; sub.style.top = `${top}px` }
    else {
      // no room beside it: it takes the menu's place, with a way back
      const back = el('button', 'menuitem pback')
      back.tabIndex = -1
      back.setAttribute('role', 'menuitem')
      back.append(icon('chevron', 'mchev back'), el('span', '', 'Model'))
      back.setAttribute('aria-label', 'Back to Model')
      back.onclick = e => { e.stopPropagation(); closeSub(true) }
      sub.prepend(back)
      main.hidden = true
      sub.style.left = `${r.left}px`
      sub.style.top = `${Math.max(8, r.bottom - sub.getBoundingClientRect().height)}px`
    }
    ;(sub.querySelector('.menuitem[aria-checked="true"]') || sub.querySelector('.menuitem:not(.pback)') || sub.querySelector('.menuitem'))?.focus()
  }

  if (kind === 'model') {
    main.appendChild(el('div', 'menuhead', 'Model · this chat'))
    for (const x of split.top) row(main, x.label || x.value, { on: isPicked(x, p.model), tip: x.note, pick: () => setPick(c, 'model', x.value) })
    sep(main)
    row(main, 'Effort', { sub: 'effort', value: capWord(p.effort) || 'Default' })
    if (split.rest.length) { sep(main); row(main, 'More models', { sub: 'more' }) }
  } else {
    main.appendChild(el('div', 'menuhead', 'Permissions'))
    // only the modes on offer can be picked; one no longer offered (bypass, after its
    // setting went off) still shows as the current one on the button
    for (const [v, label, tip] of modes()) row(main, label, { on: v === p.mode, tip, pick: () => setMode(c, v) })
  }
  wrap.onkeydown = e => {
    const at = e.target.closest?.('.pickmenu')
    if (!at) return
    // Tab leaves the menu: it closes, focus goes back to its control, and Tab carries on
    // from there (the rows are not tab stops; arrows move between them)
    if (e.key === 'Tab') { kill(); return }
    const items = [...at.querySelectorAll('.menuitem')]
    const i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (e.key === 'ArrowRight' && document.activeElement?.dataset.sub) {
      e.preventDefault()
      if (sub?.dataset.what !== document.activeElement.dataset.sub) document.activeElement.click()
    } else if (e.key === 'ArrowLeft' && at === sub) { e.preventDefault(); closeSub(true) }
  }
  document.body.appendChild(wrap)
  // the box sits at the bottom: the menu opens above its control
  const r = anchor.getBoundingClientRect()
  const m = main.getBoundingClientRect()
  main.style.left = `${Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8))}px`
  // above its control when it fits there or there is more room there, else below; on
  // that side it is never taller than the room, and scrolls inside when it must
  const roomAbove = r.top - 4 - 8
  const roomBelow = window.innerHeight - r.bottom - 4 - 8
  const up = m.height <= roomAbove || roomAbove >= roomBelow
  const h = Math.max(0, Math.min(m.height, up ? roomAbove : roomBelow))
  main.style.maxHeight = `${h}px`
  main.style.top = `${up ? r.top - 4 - h : r.bottom + 4}px`
  anchor.setAttribute('aria-expanded', 'true')
  // no tooltip over its own open menu
  const tip = anchor.title
  anchor.removeAttribute('title')
  const kill = dismissOn(wrap, () => {
    // closed with Escape or by a choice: the keyboard goes back to the control it came from
    const inside = wrap.contains(document.activeElement)
    wrap.remove()
    if (inside) anchor.focus()
    anchor.setAttribute('aria-expanded', 'false')
    if (tip) anchor.title = tip
    PICK_SHUT = { kind, at: Date.now() }
  })
  ;(main.querySelector('.menuitem[aria-checked="true"]') || main.querySelector('.menuitem'))?.focus()
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

/** A model or effort for this chat, from /model, /effort or the menu. What you have typed is left alone. */
function setPick (c, kind, arg) {
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
  paintPickers(c)
  c.status.textContent = kind === 'model' ? 'Model: ' + modelName(arg) : 'Effort: ' + arg
  setTimeout(() => { if (c.status.textContent.startsWith(kind === 'model' ? 'Model:' : 'Effort:')) paintStatus(c) }, 2500)
  return true
}
/** "/model opus" typed and sent: the pick is made and the command leaves the box. */
function applyLocal (c, kind, arg) {
  if (!setPick(c, kind, arg)) return false
  c.ta.value = ''
  CHAT.drafts.delete(c.id)
  c.slash.hidden = true
  c.fit?.()
  paintGo(c)
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
  const canAlways = a.suggestions.length && !a.noAlways
  // a risky one leads with No, as Claude's terminal does
  const deny = el('button', a.defaultNo ? 'btn pri' : 'btn', 'Deny')
  deny.title = 'Claude is told no, and tries another way'
  deny.onclick = () => answer(c, a, { allow: false })
  if (a.defaultNo) acts.appendChild(deny)
  const allow = el('button', a.defaultNo ? 'btn' : 'btn pri', canAlways ? 'Allow once' : 'Allow')
  allow.onclick = () => answer(c, a, { allow: true })
  acts.appendChild(allow)
  if (['Edit', 'Write', 'MultiEdit'].includes(a.tool)) {
    const diff = el('button', 'btn', 'Open diff')
    diff.title = 'See the change beside the file as it is now, in the editor'
    diff.onclick = () => send({ type: 'chatAskDiff', id: c.id, requestId: a.requestId })
    acts.appendChild(diff)
  }
  if (canAlways) {
    const always = el('button', 'btn', 'Always allow')
    always.onclick = () => answer(c, a, { allow: true, always: true })
    acts.appendChild(always)
  }
  if (!a.defaultNo) acts.appendChild(deny)
  const halt = el('button', 'btn', 'Deny and stop')
  halt.title = 'Claude is told no, and the reply ends here'
  halt.onclick = () => answer(c, a, { allow: false, stop: true })
  acts.appendChild(halt)
  const instead = el('input', 'caskinput')
  instead.placeholder = 'Or tell Claude what to do instead, then Enter'
  instead.onkeydown = e => {
    if (e.key === 'Enter' && instead.value.trim()) answer(c, a, { allow: false, message: instead.value.trim() })
  }
  card.appendChild(acts)
  // what "Always allow" would save, in words, not only on hover
  if (canAlways) card.appendChild(el('div', 'caskwhy caskalways', 'Always allow: ' + alwaysTip(a).split('\n').join('; ')))
  card.appendChild(instead)
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
    if (m.type === 'limitNotice') {
      const n = m.notice
      LIMIT_NOTICE = n && typeof n.kind === 'string' && typeof n.status === 'string' ? { kind: n.kind, status: n.status, resetsAt: Number(n.resetsAt) || 0 } : null
      if (COMPOSER) paintLimit(COMPOSER)
      return
    }
    if (m.type === 'chatDropFiles') { dropRead(m); return }
    if (!m.type.startsWith('chat') || !m.id) return
    const id = m.id
    const st = CHAT.state.get(id) || { id, asks: [] }
    switch (m.type) {
      case 'chatState':
        if (m.state.busy && !st.busy) CHAT.busySince.set(id, Date.now())
        // Claude stopped: no answer will come to a pick still waiting, which then simply stands
        if (!m.state.running && CHAT.picks.get(id)?.modeAsk) CHAT.picks.get(id).modeAsk = null
        // a task that has gone takes its open output and its "Stopping…" with it
        for (const k of [...CHAT.taskOut.keys(), ...CHAT.stopping]) {
          if (k.startsWith(id + '|') && !(m.state.bg || []).some(t => k === id + '|' + t.id)) { CHAT.taskOut.delete(k); CHAT.stopping.delete(k) }
        }
        // the host's word wins, except the note that a message was just sent from here (kept until exit, at most 30s)
        CHAT.state.set(id, { ...m.state, ...(st.sentHere ? { sentHere: st.sentHere } : {}) })
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
            CHAT.drawLater = setTimeout(() => {
              CHAT.drawLater = null
              CHAT.drewAt = Date.now()
              // only the reply's own text changes: the buttons and cards around it, and focus, stay put
              const text = CHAT.partial.get(id)?.text
              const b = COMPOSER?.id === id && COMPOSER.live.querySelector('.chatstream .bubble')
              if (b && text) { b.innerHTML = window.md(text); if (FOLLOW) stickToEnd(COMPOSER.live.parentNode) }
              else if (COMPOSER?.id === id) placeLive()
            }, 500)
            return
          }
          // drawn now: a later draw still waiting is no longer needed
          clearTimeout(CHAT.drawLater); CHAT.drawLater = null
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
      case 'chatModeDone': {
        // the answer to the latest pick: from here on the mode Claude reports shows.
        // An answer to an older pick leaves the newer one waiting for its own
        const p = picksFor(id)
        if (p.modeAsk?.req === m.req) { p.modeAsk = null; if (COMPOSER?.id === id) paintPickers(COMPOSER) }
        break
      }
      case 'chatNotice':
        if (m.soft && CHAT.notes.get(id)?.action) break   // a passing word never covers one you can act on
        note(id, m.text, false, m.action === 'terminal' ? { label: 'Open Claude in a terminal', msg: { type: 'chatTerminal' } } : undefined)
        break
      case 'chatTitle': {
        const h2 = COMPOSER?.id === id && document.querySelector('#detail .dtop h2')
        if (h2) h2.textContent = m.title
        break
      }
      case 'chatMoved': {
        // /clear: the chat goes on under a new id; the view follows it there
        moveChatState(id, m.to)
        CHAT.echo.delete(m.to)
        CHAT.here.set(m.to, { folder: '' })
        if (COMPOSER?.id === id) {
          refreshPoints(COMPOSER)
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
        // only an open card takes it: one closed, even while it was still asking, stays closed
        if (CHAT.mcp.has(id)) CHAT.mcp.set(id, Array.isArray(m.list) ? m.list : 'unavailable')
        if (m.done) mcpDone(id, m.done, m.seq)
        if (m.err) note(id, m.err, true)
        break
      case 'chatMcpDone':
        mcpDone(id, m.name, m.seq)
        if (m.err) note(id, m.err, true)
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
        CHAT.state.set(id, { ...st, running: false, busy: false, asks: [], endedAt: Date.now(), sentHere: 0 })
        // a pick still waiting gets no answer now: it stands as the choice for the next run
        if (CHAT.picks.get(id)?.modeAsk) CHAT.picks.get(id).modeAsk = null
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
        CHAT.state.set(id, { ...st, busy: false, sentHere: 0 })
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

// Escape closes the /mcp card wherever focus is in the chat - after clicking a
// switch, focus is on the card, not in the box. Fields and menus keep their own Escape.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  if (e.target.closest?.('input, textarea, select, .ctx')) return
  const id = COMPOSER?.id
  if (!id || !CHAT.mcp.has(id)) return
  e.preventDefault()
  CHAT.mcp.delete(id)
  paintLive()
})
