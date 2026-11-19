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
  state: new Map(),      // chat id -> what the host says about its Claude here
  drafts: new Map(),     // chat id -> unsent text
  images: new Map(),     // chat id -> pasted pictures waiting to go
  echo: new Map(),       // chat id -> a message sent but not yet in the transcript
  partial: new Map(),    // chat id -> the reply being written
  landed: new Set(),     // chats whose half-written reply is now in the transcript
  notes: new Map(),      // chat id -> { err, text } shown under the conversation
  picks: new Map(),      // chat id -> { model, mode, effort } chosen here
  done: new Map(),       // chat id -> when the last reply finished, and how long it took
  here: new Map(),       // new chats started in the logbook: id -> { copyOf, folder }
  commands: [],          // slash commands, as the last Claude to start listed them
  models: [],
}
let COMPOSER = null

const MODES = [
  ['default', 'Ask first', 'Claude asks before editing files or running commands'],
  ['acceptEdits', 'Accept edits', 'File edits go through; commands still ask'],
  ['plan', 'Plan first', 'Claude plans and asks you to approve before changing anything'],
  ['auto', 'Auto', 'Claude decides what is safe to run without asking'],
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
  if (!CHAT.picks.has(id)) CHAT.picks.set(id, { model: '', mode: CFG.chatPermissionMode || 'default', effort: '' })
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
  if (t.pending) pendingIntro(t.id)
  placeLive()
  paintComposer()
}

/** A new chat started here says so, in place of the "started in a terminal" note. */
function pendingIntro (id) {
  const d = $('#detail')
  const info = CHAT.here.get(id) || {}
  const h2 = d.querySelector('.dtop h2')
  if (h2) h2.textContent = info.copyOf ? `Copy of ${info.copyOf}` : 'New chat'
  const wait = d.querySelector('.pendingchat')
  if (wait) {
    const sent = CHAT.echo.has(id) || CHAT.partial.has(id)
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

function paintLive () {
  if (!COMPOSER) return
  const id = COMPOSER.id
  const live = COMPOSER.live
  live.replaceChildren()
  const echo = CHAT.echo.get(id)
  if (echo) {
    const w = el('div', 'msg user chatecho')
    if (echo.text) w.appendChild(el('div', 'bubble', echo.text))
    if (echo.images) w.appendChild(el('div', 'chatmeta', `${echo.images} image${echo.images === 1 ? '' : 's'} attached`))
    live.appendChild(w)
  }
  const st = CHAT.state.get(id)
  const p = CHAT.partial.get(id)
  if (p?.text) {
    const w = el('div', 'msg assistant chatstream')
    const b = el('div', 'bubble')
    b.innerHTML = window.md(p.text)
    w.appendChild(b)
    live.appendChild(w)
  }
  if (st?.busy && !(st.asks || []).length) {
    const line = el('div', 'chatworking')
    line.append(el('span', 'chatdots'), el('span', '',
      p?.tool && !p.text ? `Running ${toolWord(p.tool)}…` : p?.thinking ? 'Thinking…' : p?.text ? 'Writing…' : 'Working…'))
    live.appendChild(line)
  }
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
  const model = el('select', 'cpick')
  const mode = el('select', 'cpick')
  const effort = el('select', 'cpick')
  model.title = 'Model for this chat'
  mode.title = 'What Claude may do without asking'
  effort.title = 'Effort: how hard Claude thinks. Changing it restarts Claude between replies'
  const status = el('span', 'cstatus')
  const go = el('button', 'cgo')
  bar.append(model, mode, effort, status, go)
  const live = el('div', 'chatlive')
  // the text and its pickers share one box, the way a chat app's input reads
  const box = el('div', 'cbox')
  box.append(imgs, ta, bar)
  box.onclick = e => { if (e.target === box || e.target === bar) ta.focus() }
  root.append(asks, block, box, slash)
  const c = { id, root, asks, imgs, block, ta, slash, bar, model, mode, effort, status, go, live, slashAt: 0 }

  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px' }
  c.fit = fit
  ta.oninput = () => { CHAT.drafts.set(id, ta.value); fit(); paintSlash(c); paintGo(c) }
  ta.onkeydown = e => {
    if (!c.slash.hidden && slashKey(c, e)) return
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
  model.onchange = () => { picksFor(id).model = model.value; send({ type: 'chatModel', id, value: model.value }); paintPickers(c) }
  mode.onchange = () => { picksFor(id).mode = mode.value; send({ type: 'chatMode', id, value: mode.value }) }
  effort.onchange = () => { picksFor(id).effort = effort.value; send({ type: 'chatEffort', id, value: effort.value }) }
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
  if (whereRunning(id) === 'elsewhere') return
  const p = picksFor(id)
  send({ type: 'chatSend', id, text, images: images.map(im => ({ mediaType: im.mediaType, data: im.data })), model: p.model, mode: p.mode, effort: p.effort })
  CHAT.echo.set(id, { text, images: images.length, at: Date.now() })
  CHAT.notes.delete(id)
  CHAT.done.delete(id)
  CHAT.drafts.delete(id)
  CHAT.images.delete(id)
  const st = CHAT.state.get(id) || { id, asks: [] }
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
    c.block.appendChild(el('span', '', 'This chat is running in a terminal or another app. Reply there, or carry it on here as a copy.'))
    const b = el('button', 'btn', 'Continue here as a copy')
    b.title = 'A new chat with this one\'s full context, run from the logbook'
    b.onclick = () => send({ type: 'chatFork', id })
    c.block.appendChild(b)
  }
  c.ta.placeholder = CHAT.state.get(id)?.busy
    ? 'Claude is working. Type to queue a message, Escape to stop'
    : where === 'here' || CHAT.here.has(id) ? 'Message Claude… (/ for commands)'
      : 'Continue this chat here… (/ for commands)'
  paintPickers(c)
  paintAsks(c)
  paintImages(c)
  paintGo(c)
  paintStatus(c)
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
    : st?.busy ? '' : done && Date.now() - done.at < 60000 && done.ms ? `Done in ${secs(done.ms)}` : ''
}

const secs = ms => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's'

function paintPickers (c) {
  const p = picksFor(c.id)
  const st = CHAT.state.get(c.id)
  // once Claude is running, what it reports wins: plan approval switches the mode
  if (st?.running && st.mode && MODES.some(m => m[0] === st.mode)) p.mode = st.mode
  const models = CHAT.models.length ? CHAT.models.filter(m => m.value !== 'default') : FALLBACK_MODELS
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
  opts(c.model, [['', 'Model'], ...models.map(m => [m.value, m.label, m.note])], p.model)
  opts(c.mode, MODES, p.mode)
  const chosen = models.find(m => m.value === p.model)
  const levels = chosen?.efforts?.length ? chosen.efforts : EFFORTS
  opts(c.effort, [['', 'Effort'], ...levels.map(l => [l, l[0].toUpperCase() + l.slice(1) + ' effort'])], p.effort)
}

// ------------------------------------------------------------ slash commands

function slashMatches (c) {
  const m = /^\/([\w:-]*)$/.exec(c.ta.value)
  if (!m || !CHAT.commands.length) return []
  const q = m[1].toLowerCase()
  return CHAT.commands.filter(x => x.name.toLowerCase().includes(q))
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
  c.ta.value = '/' + x.name + ' '
  CHAT.drafts.set(c.id, c.ta.value)
  c.slash.hidden = true
  c.ta.focus()
  paintGo(c)
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
  const sendBtn = el('button', 'btn pri', qs.length > 1 ? 'Send answers' : 'Send answer')
  const ready = () => { sendBtn.disabled = !qs.every((q, i) => chosen[i].size || other[i]?.value.trim()) }
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
    box.append(opts, own)
    card.appendChild(box)
  })
  sendBtn.onclick = () => {
    const answers = {}
    qs.forEach((q, i) => { answers[q.question] = other[i].value.trim() || [...chosen[i]].join(', ') })
    answer(c, a, { allow: true, answers })
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
  const echo = CHAT.echo.get(id)
  if (echo) {
    const users = (t.turns || []).filter(x => x.role === 'user' && x.text)
    const last = users[users.length - 1]
    const want = echo.text.trim().slice(0, 120)
    if ((last && want && String(last.text).includes(want)) || Date.now() - echo.at > 15000) CHAT.echo.delete(id)
  }
  if (CHAT.landed.has(id)) { CHAT.landed.delete(id); CHAT.partial.delete(id) }
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
    if (m.type === 'env' && m.cfg) { chatMount(); if (!chatOn()) return }
    if (m.type === 'sessions' || m.type === 'env') { if (COMPOSER && chatTarget()?.id === COMPOSER.id) paintComposer(); return }
    if (!m.type.startsWith('chat') || !m.id) return
    const id = m.id
    const st = CHAT.state.get(id) || { id, asks: [] }
    switch (m.type) {
      case 'chatState':
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
        const echo = CHAT.echo.get(id)
        CHAT.echo.delete(id)
        CHAT.state.set(id, { ...st, busy: false })
        if (echo?.text && !CHAT.drafts.get(id)) {
          CHAT.drafts.set(id, echo.text)
          if (COMPOSER?.id === id) { COMPOSER.ta.value = echo.text; COMPOSER.fit() }
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
