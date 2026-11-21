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
}
let COMPOSER = null

const MODES = [
  ['default', 'Ask first', 'Claude asks before editing files or running commands'],
  ['acceptEdits', 'Accept edits', 'File edits go through; commands still ask'],
  ['plan', 'Plan first', 'Claude plans and asks you to approve before changing anything'],
  ['auto', 'Auto mode', 'Claude decides what is safe to run without asking'],
]
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
  if (!chatOn()) { COMPOSER?.root.remove(); return }
  const t = chatTarget()
  if (!t) return
  const d = $('#detail')
  const fresh = !COMPOSER || COMPOSER.id !== t.id
  if (fresh) {
    COMPOSER = buildComposer(t.id)
    send({ type: 'chatState', id: t.id })
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
  setCfg('chatPermissionMode', value)          // and every new chat after it
}
/** Shift+Tab in the box steps through the modes, as it does in Claude Code's terminal. */
function cycleMode (c) {
  const i = MODES.findIndex(m => m[0] === picksFor(c.id).mode)
  setMode(c, MODES[(i + 1) % MODES.length][0])
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
  const at = CHAT.busySince.get(id)
  return at ? `${secs(Date.now() - at)} · Esc to stop` : 'Esc to stop'
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
      echo.images ? `${echo.images} image${echo.images === 1 ? '' : 's'} attached` : ''].filter(Boolean).join(' · ')
    if (meta) w.appendChild(el('div', 'chatmeta', meta))
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
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight })
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
  // the one status line, as Claude Code's terminal has: what it is doing, for how long
  if ((st?.asks || []).length) {
    const line = el('div', 'chatworking wait')
    line.append(el('span', 'chatwaitdot'), el('span', '', 'Waiting for you: answer below'))
    live.appendChild(line)
  } else if (st?.busy) {
    const line = el('div', 'chatworking')
    line.append(el('span', 'chatdots'), el('span', '',
      p?.tool && !p.text ? `Running ${toolWord(p.tool)}…` : p?.thinking ? 'Thinking…' : p?.text ? 'Writing…' : 'Working…'),
    el('span', 'chatel', elapsed(id)))
    live.appendChild(line)
  } else if (st?.bg?.length) {
    // the reply is done, but agents or commands it started are still going:
    // Claude picks their results up by itself when they finish
    const n = st.bg.length
    const line = el('div', 'chatworking')
    line.title = st.bg.map(t => t.what).filter(Boolean).join('\n')
    line.append(el('span', 'chatdots'), el('span', '',
      `Waiting for ${n} background ${n === 1 ? 'task' : 'tasks'}${st.bg[0].what && n === 1 ? `: ${st.bg[0].what}` : ''}`))
    live.appendChild(line)
  }
  echoes.filter(isQueued).forEach(drawEcho)
  const note = CHAT.notes.get(id)
  if (note) {
    const n = el('div', 'chatnote' + (note.err ? ' err' : ''))
    n.appendChild(el('span', '', note.text))
    const x = el('button', 'iconbtn', '×')
    x.title = 'Dismiss'
    x.onclick = () => { CHAT.notes.delete(id); paintLive() }
    n.appendChild(x)
    live.appendChild(n)
  }
  live.hidden = !live.children.length
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
  bar.append(go)
  const live = el('div', 'chatlive')
  // the text and its pickers share one box, the way a chat app's input reads
  const box = el('div', 'cbox')
  box.append(imgs, ta, bar)
  box.onclick = e => { if (e.target === box || e.target === bar) ta.focus() }
  // once, the first time anyone sees the box: what it is and where to turn it off
  const tip = el('div', 'ctip')
  root.append(asks, block, tip, box, slash)
  const c = { id, root, asks, imgs, block, tip, ta, slash, bar, mode, status, go, live, slashAt: 0 }

  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px' }
  c.fit = fit
  ta.oninput = () => { CHAT.drafts.set(id, ta.value); fit(); paintSlash(c); paintGo(c) }
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
    const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean)
    if (!files.length) return
    e.preventDefault()
    files.forEach(f => addImage(c, f))
  }
  root.ondragover = e => { if ([...(e.dataTransfer?.items || [])].some(i => i.type.startsWith('image/'))) e.preventDefault() }
  root.ondrop = e => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    files.forEach(f => addImage(c, f))
  }
  go.onclick = () => {
    const st = CHAT.state.get(id)
    if (st?.busy && !ta.value.trim() && !(CHAT.images.get(id) || []).length) send({ type: 'chatStop', id })
    else submit(c)
  }
  mode.onchange = () => setMode(c, mode.value)
  requestAnimationFrame(fit)
  return c
}

function addImage (c, file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { note(c.id, 'Only PNG, JPEG, GIF and WebP pictures can be sent.', true); return }
  if (file.size > MAX_IMAGE) { note(c.id, 'That picture is over 5 MB.', true); return }
  const r = new FileReader()
  r.onload = () => {
    const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(r.result))
    if (!m) return
    const list = CHAT.images.get(c.id) || []
    list.push({ mediaType: m[1], data: m[2], url: String(r.result) })
    CHAT.images.set(c.id, list.slice(0, 8))
    paintImages(c)
    paintGo(c)
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
  c.imgs.hidden = !list.length
}

function submit (c) {
  const id = c.id
  const text = c.ta.value
  const images = CHAT.images.get(id) || []
  if (!text.trim() && !images.length) return
  if (!images.length && localCommand(c, text)) return
  if (whereRunning(id) === 'elsewhere') return
  // "!" runs a command in the chat's folder, as in Claude Code's terminal: Claude
  // does not answer it, but gets the command and its output with your next message
  if (!images.length && /^\s*!/.test(text)) {
    const cmd = text.replace(/^\s*!/, '').trim()
    if (!cmd) return
    const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    CHAT.shell.set(id, [...(CHAT.shell.get(id) || []), { key, cmd, out: '', running: true, code: null }])
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
  send({ type: 'chatSend', id, text, images: images.map(im => ({ mediaType: im.mediaType, data: im.data })), model: p.model, mode: p.mode, effort: p.effort })
  const queued = !!CHAT.state.get(id)?.busy
  CHAT.echo.set(id, [...(CHAT.echo.get(id) || []), { text, images: images.length, at: Date.now(), queued }])
  CHAT.notes.delete(id)
  CHAT.done.delete(id)
  CHAT.drafts.delete(id)
  CHAT.images.delete(id)
  const st = CHAT.state.get(id) || { id, asks: [] }
  if (!st.busy) CHAT.busySince.set(id, Date.now())
  CHAT.state.set(id, { ...st, busy: true })
  c.ta.value = ''
  c.fit()
  c.slash.hidden = true
  paintImages(c)
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
    const mine = (CUR?.id === c.id ? CUR.turns || [] : []).filter(t => t.role === 'user' && t.text).map(t => String(t.text))
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

function note (id, text, err) {
  CHAT.notes.set(id, { text, err })
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
    const place = {
      terminal: 'Running in a terminal in this window.',
      claude: 'Running in the Claude Code panel.',
      desktop: 'Running in Claude Desktop.',
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
    const b = el('button', 'btn', 'New chat from this one')
    b.title = 'A new chat here with this one\'s full history. The original keeps running on its own'
    b.onclick = () => send({ type: 'chatFork', id })
    c.block.appendChild(b)
  } else if (CHAT.cutoff.has(id) && !CHAT.state.get(id)?.busy) {
    c.block.hidden = false
    c.block.appendChild(el('span', '', 'Claude\'s last reply was cut off when the window reloaded or closed.'))
    const go = el('button', 'btn pri', 'Continue')
    go.title = 'Asks Claude to pick up where it stopped'
    go.onclick = () => { c.ta.value = 'Your last reply was cut off when the editor window reloaded. Please continue from where you stopped.'; submit(c) }
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
  const empty = !c.ta.value.trim() && !(CHAT.images.get(c.id) || []).length
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
  if (st?.running && st.mode && MODES.some(m => m[0] === st.mode)) p.mode = st.mode
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
  opts(c.mode, MODES, p.mode)
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
]

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
  const m = /^\/(model|effort)(?:\s+(\S+))?\s*$/.exec(text.trim())
  if (!m) return false
  if (!m[2]) { c.ta.value = '/' + m[1] + ' '; paintSlash(c); return true }
  return applyLocal(c, m[1], m[2])
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
    row.append(el('b', '', '/' + x.name), el('span', '', x.hint ? `${x.hint}  ${x.description}` : x.description))
    row.onmousedown = e => { e.preventDefault(); pickSlash(c, x) }
    c.slash.appendChild(row)
  })
}

function pickSlash (c, x) {
  if (x.kind) { applyLocal(c, x.kind, x.arg); c.ta.focus(); return }
  c.ta.value = '/' + x.name + ' '
  CHAT.drafts.set(c.id, c.ta.value)
  c.slash.hidden = true
  c.ta.focus()
  paintGo(c)
  if (LOCAL.some(l => l.name === x.name)) paintSlash(c)      // straight on to its choices
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
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !list.some(x => '/' + x.name === c.ta.value.trim()))) {
    e.preventDefault()
    pickSlash(c, list[c.slashAt] || list[0])
    return true
  }
  if (e.key === 'Escape') { e.preventDefault(); c.slash.hidden = true; return true }
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
  switch (a.tool) {
    case 'Bash': return 'Claude wants to run a command'
    case 'Write': return `Claude wants to write ${fileName(i.file_path) || 'a file'}`
    case 'Edit': case 'MultiEdit': return `Claude wants to edit ${fileName(i.file_path) || 'a file'}`
    case 'NotebookEdit': return `Claude wants to edit ${fileName(i.notebook_path) || 'a notebook'}`
    case 'WebFetch': return 'Claude wants to fetch a web page'
    case 'WebSearch': return 'Claude wants to search the web'
    case 'Read': return `Claude wants to read ${fileName(i.file_path) || 'a file'}`
    default: return `Claude wants to use ${a.tool.replace(/^mcp__([^_]+)__/, '$1: ')}`
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
    if (i.description) wrap.appendChild(el('div', 'caskwhy', i.description))
  } else if (a.tool === 'Write') {
    const lines = String(i.content || '').split('\n')
    wrap.appendChild(pre(lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… ${lines.length - 40} more lines` : '')))
  } else if (a.tool === 'Edit') {
    wrap.appendChild(diffBox([[i.old_string, i.new_string]]))
  } else if (a.tool === 'MultiEdit') {
    wrap.appendChild(diffBox((i.edits || []).map(e => [e.old_string, e.new_string])))
  } else if (a.tool === 'WebFetch') {
    wrap.appendChild(el('div', 'caskwhy', String(i.url || '')))
  } else if (a.tool === 'WebSearch') {
    wrap.appendChild(el('div', 'caskwhy', String(i.query || '')))
  } else if (!path) {
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
  const card = el('div', 'cask')
  card.appendChild(el('div', 'caskhead', askTitle(a)))
  card.appendChild(askBody(a))
  const acts = el('div', 'caskacts')
  const allow = el('button', 'btn pri', 'Allow')
  allow.onclick = () => answer(c, a, { allow: true })
  acts.appendChild(allow)
  if (a.suggestions.length) {
    const always = el('button', 'btn', 'Always allow')
    always.title = alwaysTip(a)
    always.onclick = () => answer(c, a, { allow: true, always: true })
    acts.appendChild(always)
  }
  const deny = el('button', 'btn', 'Deny')
  deny.onclick = () => answer(c, a, { allow: false })
  acts.appendChild(deny)
  const instead = el('input', 'caskinput')
  instead.placeholder = 'Or tell Claude what to do instead, then Enter'
  instead.onkeydown = e => {
    if (e.key === 'Enter' && instead.value.trim()) answer(c, a, { allow: false, message: instead.value.trim() })
  }
  card.append(acts, instead)
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
  const ready = () => { sendBtn.disabled = !qs.every((q, i) => chosen[i].size || other[i]?.value.trim() || pics[i].length) }
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
        r.onload = () => {
          const m = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(r.result))
          if (!m) return
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
    if (m.type === 'chatWhere') { CHAT.where.set(m.id, { where: m.where || '', at: Date.now() }); paintComposer(); return }
    if (m.type === 'chatCutoff') { CHAT.cutoff = new Set(m.ids || []); paintComposer(); return }
    if (!m.type.startsWith('chat') || !m.id) return
    const id = m.id
    const st = CHAT.state.get(id) || { id, asks: [] }
    switch (m.type) {
      case 'chatState':
        if (m.state.busy && !st.busy) CHAT.busySince.set(id, Date.now())
        CHAT.state.set(id, { ...m.state })
        if (m.state.commands?.length) CHAT.commands = m.state.commands
        if (m.state.models?.length) CHAT.models = m.state.models
        if (m.state.partial) CHAT.partial.set(id, m.state.partial)
        break
      case 'chatPartial':
        if (m.partial) CHAT.partial.set(id, m.partial); else CHAT.partial.delete(id)
        break
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
        if (m.error && !m.stopped) note(id, m.error, true)
        else if (m.stopped) note(id, 'Stopped. Type to carry on.', false)
        setTimeout(() => { if (COMPOSER?.id === id) paintStatus(COMPOSER) }, 61000)
        break
      case 'chatExit':
        CHAT.state.set(id, { ...st, running: false, busy: false, asks: [], endedAt: Date.now() })
        CHAT.partial.delete(id)
        if (m.error) note(id, m.error, true)
        break
      case 'chatError': {
        // nothing was sent: the words go back in the box rather than being lost
        const lost = (CHAT.echo.get(id) || []).map(x => x.text).filter(Boolean).join('\n\n')
        CHAT.echo.delete(id)
        CHAT.state.set(id, { ...st, busy: false })
        if (lost && !CHAT.drafts.get(id)) {
          CHAT.drafts.set(id, lost)
          if (COMPOSER?.id === id) { COMPOSER.ta.value = lost; COMPOSER.fit() }
        }
        note(id, m.error, true)
        break
      }
      default:
        return
    }
    if (COMPOSER?.id === id) { placeLive(); paintComposer() }
  })
}
