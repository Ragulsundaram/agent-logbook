'use strict'
/**
 * Chats run from inside the logbook.
 *
 * Each chat you talk to here is your own Claude Code, started in the
 * background on that chat's transcript: `claude -p` reading and writing
 * stream-json, with permission prompts handed back to us over stdio. Claude
 * keeps writing the same transcript file as in a terminal, so the chat view
 * draws the finished messages the way it always has. This file adds what the
 * file cannot show: the reply as it is being written, and the questions
 * Claude needs answered before it can go on.
 *
 * One process per chat. It stays up between messages, so a reply starts
 * without Claude loading again, and is stopped after a quiet spell.
 */
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const IDLE_MS = 15 * 60e3           // a chat nobody has used for this long is let go
const PARTIAL_MS = 90               // how often the half-written reply is sent on
const STDERR_KEEP = 4000

const RUNS = new Map()              // chat id -> its process and state
const ENDED = new Map()             // chat id -> when its Claude here last quit
const STOPPING = new Map()          // chat id -> a Claude told to leave that has not exited yet
const DEFERRED = new Map()          // chat id -> sends waiting, in order, for that Claude to go; a stop cancels them
let OPTS = { bin: () => null, emit: () => {}, onChange: () => {} }
// what the last Claude to start reported: offered before any chat has started
let KNOWN = { commands: [], models: [] }

function init (opts) { OPTS = { ...OPTS, ...opts } }

/** Take in the commands and models a Claude reported, and pass them on to be kept. */
function learn (x) {
  x = x || {}
  const commands = (x.commands || []).map(c => ({ name: String(c.name || ''), description: String(c.description || '').slice(0, 200), hint: String(c.argumentHint || '') }))
  const models = (x.models || []).map(o => ({ value: String(o.value || ''), label: String(o.displayName || o.value || ''), note: String(o.description || ''), efforts: o.supportsEffort ? (o.supportedEffortLevels || []) : [] }))
  if (!commands.length && !models.length) return
  KNOWN = { commands, models }
  try { OPTS.onKnown?.(KNOWN) } catch {}
}
/** What was kept from an earlier window, so "/" lists everything straight after a reload. */
function seedKnown (k) {
  if (k && Array.isArray(k.commands) && Array.isArray(k.models) && !KNOWN.commands.length) KNOWN = { commands: k.commands, models: k.models }
}

/**
 * Ask Claude for its commands and models without starting a chat: it starts,
 * answers the handshake and is let go. Nothing is sent to the model and no
 * chat is saved. One at a time; done is told whether it worked.
 */
let PROBING = false
let FROM_CHAT = false               // a chat here has reported its list this window
function probe (cwd, done = () => {}) {
  const bin = OPTS.bin()
  if (!bin || PROBING) return done(false)
  PROBING = true
  const env = { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH || ''}` }
  delete env.CLAUDECODE
  let proc
  try {
    // runs with nobody asking, so it runs nothing: no hooks, no MCP servers, and
    // only your own settings - a folder just opened gets no say in what starts
    proc = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}',
      '--strict-mcp-config'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  } catch { PROBING = false; return done(false) }
  let buf = '', ok = false, over = false
  const end = () => {
    if (over) return
    over = true; PROBING = false; clearTimeout(timer)
    try { proc.stdin.end() } catch {}
    try { proc.kill() } catch {}
    // one that lingers past a polite ask is not left behind
    const hard = setTimeout(() => { try { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') } catch {} }, 3000)
    hard.unref?.()
    done(ok)
  }
  const timer = setTimeout(end, 20000)
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let m; try { m = JSON.parse(line) } catch { continue }
      const res = m.type === 'control_response' && m.response
      if (res && res.request_id === 'probe') {
        // a chat that started meanwhile knows better: it also has its folder's commands
        if (res.subtype === 'success') { if (!FROM_CHAT) learn(res.response); ok = true }
        end(); return
      }
    }
  })
  proc.stdin.on('error', () => {})
  proc.on('error', end)
  proc.on('exit', end)
  try { proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'probe', request: { subtype: 'initialize' } }) + '\n') } catch { end() }
}

const has = id => RUNS.has(id)
// the live list lags a few seconds behind: a Claude that just quit here can still be listed as running
const endedRecently = id => {
  // only the last few seconds matter, so older entries go as they are asked about
  for (const [k, at] of ENDED) if (Date.now() - at > 60000) ENDED.delete(k)
  return Date.now() - (ENDED.get(id) || 0) < 10000
}

/** Running chats as the live list reads them: working, or waiting for you. */
function liveMap () {
  const out = {}
  // waiting: Claude has stopped to ask you something - neither working nor done
  // background agents or commands still going count as working: the chat is not done
  for (const [id, r] of RUNS) out[id] = r.asks.size ? 'waiting' : r.busy || r.bg.length ? 'busy' : 'idle'
  return out
}

/** What the view needs to draw a chat it is opening, or opening again. */
function state (id) {
  const r = RUNS.get(id)
  return {
    id,
    running: !!r,
    busy: !!r?.busy,
    model: r?.model || '',
    mode: r?.mode || '',
    effort: r?.effort || '',
    asks: r ? [...r.asks.values()] : [],
    retry: r?.retry || null,
    hooks: !!r?.hooksRunning,
    context: r?.context ?? null,
    thinking: r ? r.thinkingOn !== false : true,
    bg: r ? r.bg.map(t => ({ id: t.id, what: t.what, kind: t.kind, now: t.now || '', steps: t.steps || 0 })) : [],
    status: r?.status || '',
    todos: r?.todos || [],
    partial: r ? partialOf(r) : null,
    commands: KNOWN.commands,
    models: KNOWN.models,
  }
}

function partialOf (r) {
  const p = r.partial
  if (!p.text && !p.thinking && !p.tool && !r.agentAct) return null
  return {
    text: p.text, thinking: p.thinking, tool: p.tool, detail: toolDetail(p.tool, p.toolIn),
    thought: p.thought.slice(-4000), thinkTokens: p.thinkTokens || 0, toolSecs: p.toolSecs || 0,
    agent: r.agentAct || '',
  }
}
const freshPartial = () => ({ text: '', thinking: false, tool: '', toolIn: '', thought: '', thinkTokens: 0, toolSecs: 0 })

/** The command, file or address a tool is working on, read from its input as it streams in. */
function toolDetail (tool, raw) {
  if (!tool || !raw) return ''
  let v = ''
  try { const o = JSON.parse(raw); v = o.command || o.file_path || o.notebook_path || o.pattern || o.url || o.query || o.description || '' } catch {
    // still arriving: the first field that has started is enough
    const m = /"(command|file_path|notebook_path|pattern|url|query|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
    if (m) { try { v = JSON.parse('"' + m[2].replace(/\\$/, '') + '"') } catch { v = m[2] } }
  }
  return String(v).split('\n')[0].slice(0, 160)
}

function emit (id, m) { OPTS.emit({ ...m, id }) }

/**
 * Start Claude on a chat. `fresh` makes a new chat with this id, `forkOf`
 * branches a new chat with this id off another one, and otherwise the chat
 * is resumed where it left off.
 */
function start (id, { cwd, fresh, forkOf, model, mode, effort, dirs, allowBypass } = {}) {
  const bin = OPTS.bin()
  if (!bin) throw new Error('Claude Code was not found. Install it, or open a terminal once so the logbook can find it.')
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    // each message comes back with the id it was sent with: a queued one can be taken back
    '--replay-user-messages']
  // an id is always a value, never a flag of its own: it starts with a letter or digit, and goes joined to its flag
  const okId = v => /^[A-Za-z0-9][\w-]{0,127}$/.test(String(v || ''))
  if (!okId(id) || (forkOf && !okId(forkOf))) throw new Error('That chat id is not valid.')
  if (model && !/^[A-Za-z0-9][\w.[\]-]{0,59}$/.test(model)) model = ''
  if (forkOf) args.push(`--resume=${forkOf}`, '--fork-session', `--session-id=${id}`)
  else if (fresh) args.push(`--session-id=${id}`)
  else args.push(`--resume=${id}`)
  if (model) args.push(`--model=${model}`)
  if (mode) args.push('--permission-mode', mode)
  if (effort) args.push('--effort', effort)
  // the window's other folders, so Claude may work in them as it does in Claude's own panel
  for (const d of dirs || []) if (d && d !== cwd) args.push('--add-dir', d)
  // "Bypass permissions" is offered only when you have allowed it in Settings
  if (allowBypass) args.push('--allow-dangerously-skip-permissions')
  // an npm-installed claude is a node script: node sits beside it, and an
  // editor started from the Dock does not have your shell's PATH
  const env = { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH || ''}` }
  // started from inside a Claude session, the child would think it is nested
  delete env.CLAUDECODE
  // Claude keeps its to-do list with the tool the chat view draws, as in Claude's own editor panel
  env.CLAUDE_CODE_ENABLE_TASKS = '0'
  // Claude says exactly when it is working, idle or waiting: no guessing from timers
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  // a slow MCP server does not hold up the first reply
  env.MCP_CONNECTION_NONBLOCKING = 'true'
  // a Claude that cannot start says why, as a result, rather than just quitting
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1'
  // a question's choices can carry a preview, drawn as markdown
  env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT = 'markdown'
  delete env.CLAUDE_CODE_CHILD_SESSION
  const proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const r = {
    id, cwd, proc, buf: '', err: '', busy: false, model: model || '', mode: mode || '', effort: effort || '',
    asks: new Map(), partial: freshPartial(), partialTimer: null,
    idle: null, seq: 0, restart: false,
    pending: 0,                     // messages sent that Claude has not finished answering
    bg: [],                         // background agents and commands still running
    expectTurn: null,               // a background task finished: Claude's own turn is coming
    nextTurn: null,                 // a reply ended with messages still counted: their turn should start soon
    stopCheck: null,                // Esc was pressed: the reply should end soon
    status: '',                     // what Claude says it is busy with beyond the reply: 'compacting'
    todos: [],                      // Claude's to-do list, as its last update left it
    waits: new Map(),               // our own requests waiting on Claude's answer: request id -> callback
    sse: false,                     // Claude reports its own state: busy follows that, not the counting below
    lastResult: null,               // the turn that just ended, told once Claude says it is idle
    retry: null,                    // Claude is retrying after an error: { attempt, max, at, why }
    hooksRunning: false,
    context: null,                  // how full the context is, as Claude counts it (percent)
    agentAct: '',                   // what a sub-agent is doing right now
    sawInit: false,
  }
  RUNS.set(id, r)
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', d => {
    r.buf += d
    let i
    while ((i = r.buf.indexOf('\n')) >= 0) {
      const line = r.buf.slice(0, i)
      r.buf = r.buf.slice(i + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      // a Claude being let go after a newer one took the chat over is not listened to
      if (r.stopping && RUNS.has(r.id) && RUNS.get(r.id) !== r) continue
      try { onLine(r, m) } catch {}
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', d => {
    r.err = (r.err + d).slice(-STDERR_KEEP)
    // new terms to accept: Claude waits on them, and only its own terminal can show them
    if (!r.termsSaid && /Consumer Terms|accept the updated terms/i.test(String(d))) {
      r.termsSaid = true
      emit(r.id, { type: 'chatNotice', text: 'Anthropic has updated its terms. Accept them in Claude in a terminal, then carry on here.', action: 'terminal' })
    }
  })
  // EPIPE when Claude has quit with a write on its way: the exit handler says so
  proc.stdin.on('error', () => {})
  // a claude that could not start at all raises only 'error', one that ran
  // raises 'exit': either way the chat is told once
  proc.on('error', e => { r.err += '\n' + e.message; finish(1) })
  proc.on('exit', code => finish(code))
  function finish (code) {
    if (r.ended) return
    r.ended = true
    clearTimeout(r.idle); clearTimeout(r.partialTimer); clearTimeout(r.expectTurn); clearTimeout(r.nextTurn); clearTimeout(r.stopCheck)
    for (const cb of r.waits.values()) { try { cb(null) } catch {} }
    r.waits.clear()
    // the chat's id now, which /clear may have changed since it started
    const id = r.id
    if (RUNS.get(id) === r) RUNS.delete(id)
    ENDED.set(id, Date.now())
    // a newer Claude already took this chat over (a message sent while this one
    // was being let go): its leaving is not news, and must not mark the chat stopped
    if (RUNS.has(id)) return
    // a quiet stop (let go when idle, or restarted for a new setting) says nothing
    const quiet = r.stopping
    if (!quiet) {
      let why = r.err.trim().split('\n').slice(-6).join('\n')
      if (/ENOENT/.test(why)) why = 'Claude Code was not found. Install it, or open a terminal once so the logbook can find it.'
      emit(id, { type: 'chatExit', code, error: code ? (why || `Claude stopped (exit code ${code}).`) : '' })
    } else emit(id, { type: 'chatExit', code: 0, error: '' })
    OPTS.onChange(id)
  }
  const init = { subtype: 'initialize', supportedDialogKinds: ['auto_mode_server_fallback'] }
  // the editor's part: unsaved files saved before Claude reads or edits them, new problems told after an edit
  if (OPTS.onHook) {
    init.hooks = {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|Read|NotebookEdit', hookCallbackIds: ['lb_save'] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hookCallbackIds: ['lb_problems'] }],
    }
  }
  write(r, { type: 'control_request', request_id: 'init', request: init })
  armIdle(r)
  OPTS.onChange(id)
  return r
}

function write (r, obj) {
  try { r.proc.stdin.write(JSON.stringify(obj) + '\n') } catch {}
}

function control (r, request, onAnswer, wait = 10000) {
  const request_id = `lb-${++r.seq}`
  // an answer that never comes still calls back, so nothing waits for ever
  if (onAnswer) {
    const t = setTimeout(() => { if (r.waits.delete(request_id)) onAnswer(null) }, wait)
    r.waits.set(request_id, res => { clearTimeout(t); onAnswer(res) })
  }
  write(r, { type: 'control_request', request_id, request })
  return request_id
}

function armIdle (r) {
  clearTimeout(r.idle)
  r.idle = setTimeout(() => {
    if (r.busy || r.asks.size || r.bg.length) return armIdle(r)
    stop(r.id)
  }, IDLE_MS)
}

function flushPartial (r, now) {
  if (r.partialTimer && !now) return
  const go = () => { r.partialTimer = null; emit(r.id, { type: 'chatPartial', partial: partialOf(r) }) }
  if (now) { clearTimeout(r.partialTimer); go() } else r.partialTimer = setTimeout(go, PARTIAL_MS)
}

function onLine (r, m) {
  switch (m.type) {
    case 'stream_event': {
      // an agent's own stream is left to its card - only the main reply is drawn
      if (m.parent_tool_use_id) return
      const e = m.event || {}
      if (e.type === 'message_start') {
        clearTimeout(r.expectTurn); r.expectTurn = null
        clearTimeout(r.nextTurn); r.nextTurn = null
        clearTimeout(r.stopCheck); r.stopCheck = null    // a turn did start: it ends with its own result
        r.partial = freshPartial()
        r.retry = null                // a reply is coming through: the retrying is over
        r.busy = true                 // a queued message's turn starting counts as working
      } else if (e.type === 'content_block_start') {
        const b = e.content_block || {}
        if (b.type === 'thinking' || b.type === 'redacted_thinking') r.partial.thinking = true
        if (b.type === 'tool_use' || b.type === 'server_tool_use') { r.partial.tool = b.name || 'a tool'; r.partial.toolIn = ''; r.partial.toolSecs = 0 }
        if (b.type === 'text' && r.partial.text) r.partial.text += '\n\n'
      } else if (e.type === 'content_block_delta') {
        const d = e.delta || {}
        if (d.type === 'text_delta') { r.partial.text += d.text || ''; r.partial.thinking = false }
        else if (d.type === 'thinking_delta') { r.partial.thinking = true; r.partial.thought = (r.partial.thought + (d.thinking || '')).slice(-8000) }
        // the command or file a tool is about to work on, as Claude writes it
        else if (d.type === 'input_json_delta') { if (r.partial.toolIn.length < 4000) r.partial.toolIn += d.partial_json || '' }
        else return
      } else return
      flushPartial(r)
      return
    }
    case 'assistant':
      if (m.parent_tool_use_id) {
        // a sub-agent at work: what it is doing now, so its card does not look frozen
        const uses = (Array.isArray(m.message?.content) ? m.message.content : []).filter(b => b?.type === 'tool_use')
        const u = uses[uses.length - 1]
        if (u) { r.agentAct = `${u.name}${toolDetail(u.name, JSON.stringify(u.input || {})) ? ': ' + toolDetail(u.name, JSON.stringify(u.input || {})) : ''}`; flushPartial(r) }
        return
      }
      // signed out, or the sign-in expired: nothing works until you sign in again
      if (m.error === 'authentication_failed') emit(r.id, { type: 'chatAuth' })
      // the to-do list is whatever Claude last wrote to it
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b?.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
          r.todos = b.input.todos.slice(0, 50).map(t => ({
            text: String(t.content || '').slice(0, 300), doing: String(t.activeForm || '').slice(0, 300),
            status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
          }))
          emit(r.id, { type: 'chatState', state: state(r.id) })
        }
      }
      // the whole message is in the transcript now; the view swaps the
      // half-written copy for it on its next read
      emit(r.id, { type: 'chatLanded' })
      OPTS.onWrite?.(r.id)
      return
    case 'user':
      if (!m.parent_tool_use_id) OPTS.onWrite?.(r.id)
      return
    case 'command_lifecycle':
      // a message you sent: queued, taken up, or dropped (taken back, or cleared away)
      if (m.command_uuid && m.state) emit(r.id, { type: 'chatQueue', uuid: String(m.command_uuid), state: String(m.state) })
      return
    case 'conversation_reset':
      // /clear: the new chat's own id comes with the init that follows, and the chat moves then
      r.todos = []
      return
    case 'tool_progress':
      if (m.parent_tool_use_id) return
      r.partial.toolSecs = Math.round(m.elapsed_time_seconds || 0)
      if (m.tool_name && !r.partial.tool) r.partial.tool = m.tool_name
      flushPartial(r)
      return
    case 'rate_limit_event': {
      const i = m.rate_limit_info || {}
      if (i.status && i.status !== 'allowed') emit(r.id, { type: 'chatLimit', status: String(i.status), resetsAt: Number(i.resetsAt) || 0, kind: String(i.rateLimitType || '') })
      return
    }
    case 'system':
      if (m.subtype === 'init') {
        // a new id here means Claude moved to a new chat (/clear)
        if (m.session_id && r.sawInit && m.session_id !== r.id) rekey(r, String(m.session_id))
        r.sawInit = true
        r.actualModel = m.model || ''
        if (m.permissionMode) r.mode = m.permissionMode
        emit(r.id, { type: 'chatState', state: state(r.id), actualModel: r.actualModel })
      } else if (m.subtype === 'status') {
        if (m.permissionMode) r.mode = m.permissionMode
        // a status about hooks says nothing about compacting: it is left as it was
        if (!('userPromptSubmitHooksRunning' in m)) r.status = String(m.status || '')
        r.hooksRunning = !!(m.userPromptSubmitHooksRunning || m.startupHooksRunning)
        if (m.sessionHeldElsewhere) emit(r.id, { type: 'chatNotice', text: 'This chat is also open somewhere else. Replies there and here can get mixed up.' })
        emit(r.id, { type: 'chatState', state: state(r.id) })
      } else if (m.subtype === 'session_state_changed') {
        // Claude's own word on whether it is working: idle is the end of everything you sent
        r.sse = true
        r.cliState = String(m.state || '')
        if (m.state === 'idle') {
          // a message written a moment ago has not been read yet: Claude is about to start on it
          if (!r.lastResult && Date.now() - (r.sentAt || 0) < 1500) return
          turnOver(r)
        } else {
          if (m.state === 'running' && !r.busy) r.lastResult = null
          if (!r.busy) { r.busy = true; emit(r.id, { type: 'chatState', state: state(r.id) }); OPTS.onChange(r.id) }
        }
      } else if (m.subtype === 'api_retry') {
        r.retry = { attempt: Number(m.attempt) || 0, max: Number(m.max_retries) || 0, at: Date.now() + (Number(m.retry_delay_ms) || 0), why: String(m.error || m.error_status || '').slice(0, 200) }
        emit(r.id, { type: 'chatState', state: state(r.id) })
      } else if (m.subtype === 'notification' && m.text) {
        emit(r.id, { type: 'chatNotice', text: String(m.text).slice(0, 500) })
      } else if (m.subtype === 'thinking_tokens') {
        r.partial.thinking = true
        r.partial.thinkTokens = Number(m.estimated_tokens) || r.partial.thinkTokens
        flushPartial(r)
      } else if (m.subtype === 'commands_changed' && Array.isArray(m.commands)) {
        // a skill or plugin finished loading: "/" lists it now, not after a reload
        learn({ commands: m.commands, models: KNOWN.models.map(o => ({ value: o.value, displayName: o.label, description: o.note, supportsEffort: !!o.efforts.length, supportedEffortLevels: o.efforts })) })
        emit(r.id, { type: 'chatState', state: state(r.id) })
      } else if (m.subtype === 'session_title_changed' && m.title) {
        emit(r.id, { type: 'chatTitle', title: String(m.title).slice(0, 200) })
      } else if (m.subtype === 'model_fallback' && typeof m.fallback_model === 'string') {
        // Claude moved to another model by itself: say so, and show the one it is on now
        r.actualModel = m.fallback_model
        emit(r.id, { type: 'chatFallback', model: m.fallback_model, trigger: String(m.trigger || '') })
        emit(r.id, { type: 'chatState', state: state(r.id), actualModel: r.actualModel })
      } else if (m.subtype === 'background_tasks_changed') {
        // the reply can end while agents or commands it started keep going
        const was = new Map(r.bg.map(t => [t.id, t]))
        r.bg = (Array.isArray(m.tasks) ? m.tasks : []).map(t => ({
          id: String(t.task_id || ''), what: String(t.description || '').slice(0, 120), kind: String(t.task_type || ''),
          // what an agent is doing now carries over until its next progress report
          now: was.get(String(t.task_id || ''))?.now || '', steps: was.get(String(t.task_id || ''))?.steps || 0,
        }))
        emit(r.id, { type: 'chatState', state: state(r.id) })
        OPTS.onChange(r.id)
        if (!r.bg.length && !r.busy && r.restart) { r.restart = false; stop(r.id) }
      } else if (m.subtype === 'task_progress') {
        // an agent at work: the step it is on, so its card is never a silent box
        const t = r.bg.find(x => x.id === String(m.task_id || ''))
        if (!t) return
        t.now = String(m.description || '').slice(0, 160)
        t.steps = Number(m.usage?.tool_uses) || t.steps
        emit(r.id, { type: 'chatState', state: state(r.id) })
      } else if (m.subtype === 'task_notification') {
        // Claude says for itself whether it takes the result up in a turn: a
        // stopped task, for one, starts none, and must not show "working"
        if (r.sse) return
        // an older Claude does not say: working until its turn starts, or for 30s at most
        r.busy = true
        clearTimeout(r.expectTurn)
        r.expectTurn = setTimeout(() => {
          r.expectTurn = null
          if (r.pending > 0 || !RUNS.has(r.id)) return
          r.busy = false
          emit(r.id, { type: 'chatState', state: state(r.id) })
          OPTS.onChange(r.id)
          // the turn never came: a restart waiting for the chat to be done can go ahead now
          if (r.restart && !r.bg.length && !r.asks.size) { r.restart = false; stop(r.id) }
        }, 30000)
        emit(r.id, { type: 'chatState', state: state(r.id) })
        OPTS.onChange(r.id)
      }
      return
    case 'control_request': {
      const q = m.request || {}
      if (q.subtype === 'can_use_tool') {
        const ask = {
          requestId: m.request_id,
          tool: q.tool_name || '',
          input: q.input || {},
          description: q.description || '',
          reason: q.decision_reason || '',
          path: q.blocked_path || '',
          suggestions: Array.isArray(q.permission_suggestions) ? q.permission_suggestions : [],
          kind: q.tool_name === 'AskUserQuestion' ? 'question'
            : q.tool_name === 'ExitPlanMode' ? 'plan' : 'permission',
          title: String(q.title || ''),
          name: String(q.display_name || ''),
          agent: !!q.agent_id,                  // a sub-agent is asking, not the main reply
          noAlways: !!q.suppress_always_allow_rule,
          defaultNo: !!q.default_to_no,
          server: q.mcp_server?.name ? String(q.mcp_server.name) : '',
        }
        r.asks.set(m.request_id, ask)
        flushPartial(r, true)
        emit(r.id, { type: 'chatAsk', ask })
        OPTS.onChange(r.id)
        return
      }
      if (q.subtype === 'hook_callback' && OPTS.onHook) {
        const reply = res => write(r, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: res || {} } })
        Promise.resolve().then(() => OPTS.onHook({ id: r.id, callback: q.callback_id, input: q.input || {} }))
          .then(reply, () => reply({}))
        return
      }
      if (q.subtype === 'request_user_dialog' && q.dialog_kind === 'auto_mode_server_fallback') {
        const p = q.payload || {}
        const ask = {
          requestId: m.request_id, kind: 'dialog', dialog: q.dialog_kind, tool: '', input: {},
          title: String(p.title || 'Auto mode needs you'),
          paragraphs: (Array.isArray(p.paragraphs) ? p.paragraphs : []).map(String).filter(Boolean).slice(0, 6),
          suggestions: [],
        }
        r.asks.set(m.request_id, ask)
        flushPartial(r, true)
        emit(r.id, { type: 'chatAsk', ask })
        OPTS.onChange(r.id)
        return
      }
      if (q.subtype === 'elicitation') {
        // an MCP server asking for details: not something the logbook can fill in yet
        write(r, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { action: 'decline' } } })
        emit(r.id, { type: 'chatNotice', text: `${q.mcp_server_name || 'An MCP server'} asked for details the logbook cannot collect. Answer it from a terminal if you need it.` })
        return
      }
      // nothing else is ours to answer: MCP servers run inside Claude
      write(r, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported by Agent Logbook' } })
      return
    }
    case 'control_cancel_request':
      if (r.asks.delete(m.request_id)) emit(r.id, { type: 'chatAskGone', requestId: m.request_id })
      return
    case 'control_response': {
      const res = m.response || {}
      const cb = r.waits.get(res.request_id)
      if (cb) { r.waits.delete(res.request_id); try { cb(res.subtype === 'success' ? res.response || {} : null) } catch {} return }
      if (res.request_id === 'init' && res.subtype === 'success') {
        learn(res.response)
        FROM_CHAT = true
        emit(r.id, { type: 'chatState', state: state(r.id) })
      }
      return
    }
    case 'result': {
      // each message is answered as its own turn, with its own result: a chat
      // with a message still queued is still working. Stopping drops the queue.
      // only a stop you asked for counts as stopped: the same subtype also means it failed
      const asked = Date.now() - (r.interruptedAt || 0) < 15000
      const stopped = ['aborted_streaming', 'aborted_tools', 'interrupted'].includes(m.terminal_reason) ||
        (m.subtype === 'error_during_execution' && asked)
      // an Esc counts for the turn it stopped, not for a later one that fails on its own
      r.interruptedAt = 0
      const done = { ms: m.duration_ms || 0, error: m.is_error ? errorText(m).slice(0, 2000) : '', stopped, denied: deniedOf(m) }
      // how full the context is now, as Claude counts it
      contextUsage(r)
      if (r.sse) {
        // Claude says when it is idle; that is when the chat is done, queued messages and all
        r.lastResult = done
        r.partial = freshPartial(); r.status = ''; r.retry = null; r.agentAct = ''
        clearTimeout(r.partialTimer); r.partialTimer = null
        for (const k of r.asks.keys()) emit(r.id, { type: 'chatAskGone', requestId: k })
        r.asks.clear()
        emit(r.id, { type: 'chatState', state: state(r.id) })
        OPTS.onWrite?.(r.id)
        return
      }
      r.pending = stopped ? 0 : Math.max(0, r.pending - 1)
      r.busy = r.pending > 0
      clearTimeout(r.stopCheck); r.stopCheck = null
      // Claude can take a message sent mid-reply into the reply it is already
      // writing, so one answer can cover two messages. A queued message's own
      // turn starts within a second or two; if none does, there is nothing left
      clearTimeout(r.nextTurn); r.nextTurn = null
      if (r.busy) r.nextTurn = setTimeout(() => settle(r, false), 5000)
      r.partial = freshPartial(); r.agentAct = ''
      r.status = ''
      clearTimeout(r.partialTimer); r.partialTimer = null
      // an answer that was never given is moot once the turn has ended
      for (const k of r.asks.keys()) emit(r.id, { type: 'chatAskGone', requestId: k })
      r.asks.clear()
      if (r.busy) emit(r.id, { type: 'chatState', state: state(r.id) })   // on to the queued message
      else {
        emit(r.id, { type: 'chatDone', ...done })
      }
      OPTS.onWrite?.(r.id)
      OPTS.onChange(r.id)
      armIdle(r)
      if (r.restart && !r.busy && !r.bg.length) { r.restart = false; stop(r.id) }
      return
    }
  }
}

/** What went wrong, in words: an error turn keeps its reasons in a list, not in the reply. */
const RESULT_WHY = {
  error_max_turns: 'Claude reached the most steps it may take in one reply. Send a message to let it carry on.',
  error_max_budget_usd: 'Claude reached the spending limit set for this chat.',
}
function errorText (m) {
  if (m.subtype === 'success') return String(m.result || 'Claude stopped with an error.')
  const why = (Array.isArray(m.errors) ? m.errors : []).map(String).filter(Boolean).join('; ')
  return why || RESULT_WHY[m.subtype] || String(m.result || '') || 'Claude stopped with an error.'
}

/** Tools Claude was not allowed to use this turn, by name and count: "Bash ×2". */
function deniedOf (m) {
  const n = new Map()
  for (const d of Array.isArray(m.permission_denials) ? m.permission_denials : []) {
    const k = String(d?.tool_name || '')
    if (k) n.set(k, (n.get(k) || 0) + 1)
  }
  return [...n].map(([k, c]) => c > 1 ? `${k} ×${c}` : k).join(', ')
}

/** Claude says it is idle: everything you sent has been answered, or stopped. */
function turnOver (r) {
  clearTimeout(r.nextTurn); r.nextTurn = null
  clearTimeout(r.stopCheck); r.stopCheck = null
  clearTimeout(r.expectTurn); r.expectTurn = null
  const was = r.busy
  r.busy = false; r.pending = 0
  r.partial = freshPartial(); r.status = ''; r.retry = null; r.agentAct = ''
  const done = r.lastResult || { ms: 0, error: '', stopped: Date.now() - (r.interruptedAt || 0) < 15000 }
  r.lastResult = null
  r.interruptedAt = 0
  if (was) emit(r.id, { type: 'chatDone', ...done })
  else emit(r.id, { type: 'chatState', state: state(r.id) })
  OPTS.onChange(r.id)
  armIdle(r)
  if (r.restart && !r.bg.length) { r.restart = false; stop(r.id) }
}

/** /clear moved Claude to a new chat: follow it there, under the new id. */
function rekey (r, to) {
  if (!to || to === r.id || RUNS.get(r.id) !== r) return
  const from = r.id
  RUNS.delete(from)
  ENDED.set(from, Date.now())
  r.id = to
  RUNS.set(to, r)
  r.todos = []
  emit(from, { type: 'chatMoved', to })
  emit(to, { type: 'chatState', state: state(to) })
  OPTS.onChange(from); OPTS.onChange(to)
}

/** Ask Claude how full the context is; the view shows its number rather than a guess. */
function contextUsage (r) {
  control(r, { subtype: 'get_context_usage' }, res => {
    if (!res || !Number.isFinite(res.percentage)) return
    r.context = Math.round(res.percentage)
    if (RUNS.get(r.id) === r) emit(r.id, { type: 'chatState', state: state(r.id) })
  })
}

/** Nothing more is coming: the chat is done, whatever the count of messages said. */
function settle (r, stopped) {
  clearTimeout(r.nextTurn); r.nextTurn = null
  clearTimeout(r.stopCheck); r.stopCheck = null
  if (!r.busy || r.ended || RUNS.get(r.id) !== r) return
  // the Esc this settles is used up: a later reply that fails is an error, not "stopped"
  r.interruptedAt = 0
  r.pending = 0
  r.busy = false
  r.partial = freshPartial()
  emit(r.id, { type: 'chatDone', ms: 0, error: '', stopped })
  OPTS.onChange(r.id)
  armIdle(r)
  if (r.restart && !r.bg.length) { r.restart = false; stop(r.id) }
}

/**
 * Send a message, starting Claude on the chat first if it is not running.
 * A message sent while Claude is still working waits its turn, as typing
 * ahead in the terminal does.
 */
function send (id, args) {
  const { text, images, files, cwd, fresh, forkOf, model, mode, effort, dirs, allowBypass } = args
  const uuid = /^[0-9a-f-]{36}$/i.test(String(args.uuid || '')) ? String(args.uuid) : randomUUID()
  let r = RUNS.get(id)
  // the last Claude on this chat is still on its way out: two writing one
  // transcript would tangle it, so end that one and start once it has gone
  const old = !r && STOPPING.get(id)
  if (old && old.exitCode === null && old.signalCode === null) {
    // every message sent meanwhile waits its turn, in the order it was sent
    const queue = DEFERRED.get(id)
    if (queue) { queue.push(args); return true }
    const waiting = [args]
    DEFERRED.set(id, waiting)
    try { old.kill() } catch {}
    old.once('exit', () => {
      STOPPING.delete(id)
      // stopped while they waited: none of them starts after all
      if (DEFERRED.get(id) !== waiting) return
      DEFERRED.delete(id)
      for (const a of waiting) send(id, a)
      // its tab was closed while they waited: let it go once they are answered
      if (waiting.release) release(id)
    })
    return true
  }
  if (!r) r = start(id, { cwd, fresh, forkOf, model, mode, effort, dirs, allowBypass })
  const content = []
  for (const im of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
  }
  // PDFs go as documents Claude reads; text files as their text, named
  for (const f of files || []) {
    if (f.mediaType === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name })
    else content.push({ type: 'text', text: `<attached-file name="${String(f.name).replace(/"/g, '')}">\n${f.text}\n</attached-file>` })
  }
  // what you typed always comes last: the blocks before it are the logbook's own. A
  // file sent with no words gets a line of its own, and editor context goes only with words
  const typed = text || ((files || []).some(f => f.mediaType !== 'application/pdf') ? 'See the attached file.' : '')
  if (typed) for (const c of args.context || []) content.push({ type: 'text', text: c })
  if (typed) content.push({ type: 'text', text: typed })
  // Claude's input already closed (it quit on its own): say so, so the text goes back in the box
  if (!r.proc.stdin.writable) {
    emit(id, { type: 'chatError', error: 'Claude had stopped, so the message was not sent. It is back in the box: send it again.' })
    return false
  }
  write(r, {
    type: 'user',
    uuid,
    message: { role: 'user', content: content.length === 1 && !images?.length && !files?.length && typed ? typed : content },
    parent_tool_use_id: null,
  })
  r.pending++
  r.busy = true
  r.sentAt = Date.now()
  // a reply that just ended was waiting to see whether more was coming: this is
  // more, and its own turn will settle it, so the wait must not end it first
  clearTimeout(r.nextTurn); r.nextTurn = null
  // and a message sent just after Esc is new work, not part of what was stopped
  clearTimeout(r.stopCheck); r.stopCheck = null
  armIdle(r)
  emit(id, { type: 'chatState', state: state(id) })
  OPTS.onChange(id)
  return true
}

/** Answer a permission prompt, a question or a plan. */
function answer (id, requestId, reply) {
  const r = RUNS.get(id)
  const ask = r?.asks.get(requestId)
  if (!ask) return false
  r.asks.delete(requestId)
  let response
  if (reply.allow && ask.kind !== 'dialog') {
    // a question's answers go back inside its own input, as the terminal sends them
    const input = reply.answers && ask.kind === 'question' ? { ...ask.input, answers: reply.answers } : ask.input
    response = { behavior: 'allow', updatedInput: input }
    // "always allow" saves the rule Claude itself suggested, as the terminal's
    // "don't ask again" does
    if (reply.always && ask.suggestions.length && !ask.noAlways) response.updatedPermissions = ask.suggestions
  } else if (ask.kind === 'dialog') {
    response = { behavior: 'completed', result: reply.choice === 'continue' ? 'continue' : 'interrupt' }
  } else {
    response = { behavior: 'deny', message: String(reply.message || 'The user declined this. Ask them what to do instead.') }
    // "No, and stop": the reply ends here rather than Claude trying something else
    if (reply.stop) response.interrupt = true
  }
  write(r, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  emit(id, { type: 'chatAskGone', requestId })
  OPTS.onChange(id)
  return true
}

/** Stop the reply being written. The chat stays open for the next message. */
function interrupt (id) {
  const r = RUNS.get(id)
  if (!r) return
  r.interruptedAt = Date.now()
  // like Esc in Claude's terminal: the reply stops, and so do the turns queued
  // behind it (a finished background task's, or messages you typed ahead) -
  // one press, not one per turn. Messages taken back go back in the box.
  control(r, { subtype: 'interrupt', cancel_queued: true }, res => {
    for (const u of Array.isArray(res?.cancelled) ? res.cancelled : []) emit(r.id, { type: 'chatQueue', uuid: String(u), state: 'cancelled' })
    // Claude was idle all along: nothing will end, so the chat is done now
    if (r.sse && r.cliState === 'idle') settle(r, true)
  }, 5000)
  // a view that thought it was working when nothing was hears otherwise at once
  if (!r.busy) emit(r.id, { type: 'chatDone', ms: 0, error: '', stopped: true })
  clearTimeout(r.stopCheck)
  // an older Claude that does not report its state: assume it stopped after 3s
  if (!r.sse) r.stopCheck = setTimeout(() => settle(r, true), 3000)
}

/** Stop one background agent or command; the reply and the others carry on. */
function stopTask (id, taskId) {
  const r = RUNS.get(id)
  if (!r || !r.bg.some(t => t.id === taskId)) return false
  // a stop that Claude refuses, or never answers, says so, so Stop can be pressed again
  control(r, { subtype: 'stop_task', task_id: taskId }, res => {
    if (!res && RUNS.get(r.id) === r && r.bg.some(t => t.id === taskId)) emit(r.id, { type: 'chatTaskStopFailed', taskId })
  })
  return true
}

/** What a background agent or command has printed so far. */
function taskOutput (id, taskId, done) {
  const r = RUNS.get(id)
  const t = r?.bg.find(x => x.id === taskId)
  if (!t) return done(null)
  // an agent has no output stream: its work is read from its own record
  if (/agent/i.test(t.kind)) {
    if (!OPTS.agentOutput) return done(null)
    return OPTS.agentOutput(r.id, taskId).then(text => done(text == null ? null : { output: text, truncated: false }), () => done(null))
  }
  control(r, { subtype: 'get_task_output', task_id: taskId }, res => done(res && {
    output: String(res.output || ''), truncated: !!res.truncated,
  }))
}

function setModel (id, model) {
  const r = RUNS.get(id)
  if (!r) return
  r.model = model
  control(r, { subtype: 'set_model', model: model || 'default' })
  emit(id, { type: 'chatState', state: state(id) })
}

function setMode (id, mode) {
  const r = RUNS.get(id)
  if (!r) return
  // shown only once Claude has taken it: a mode it refuses must not look switched on
  control(r, { subtype: 'set_permission_mode', mode: mode || 'default' }, res => {
    if (RUNS.get(r.id) !== r) return
    if (res) r.mode = mode
    else emit(r.id, { type: 'chatNotice', text: `Claude did not switch to that mode${mode === 'bypassPermissions' ? ': a chat started before "Skip permission prompts" was on cannot bypass them. Start a new chat for it' : ''}.` })
    emit(r.id, { type: 'chatState', state: state(r.id) })
  })
}

/**
 * Effort is fixed when Claude starts, so a change restarts it - now if it is
 * idle, otherwise once the reply in progress is done.
 */
function setEffort (id, effort) {
  const r = RUNS.get(id)
  if (!r) return
  r.effort = effort
  // changed in place, as Claude's own panel does; an older Claude that cannot is restarted
  control(r, { subtype: 'apply_flag_settings', settings: { effortLevel: effort || null } }, res => {
    if (res || RUNS.get(id) !== r) return
    if (r.busy || r.asks.size || r.bg.length) r.restart = true
    else stop(id)
  })
}

/** Take back a message still waiting its turn. done is told whether it was. */
function cancelQueued (id, uuid, done = () => {}) {
  const r = RUNS.get(id)
  if (!r) return done(false)
  control(r, { subtype: 'cancel_async_message', message_uuid: uuid }, res => done(!!res?.cancelled))
}

/** A quick side question, answered without touching the chat (/btw). */
function sideQuestion (id, question, done) {
  const r = RUNS.get(id)
  if (!r) return done(null)
  control(r, { subtype: 'side_question', question }, res => done(res && res.response != null ? String(res.response) : null), 120000)
}

/** Thinking on or off for the rest of this chat. */
function setThinking (id, on) {
  const r = RUNS.get(id)
  if (!r) return false
  r.thinkingOn = !!on
  control(r, { subtype: 'set_max_thinking_tokens', max_thinking_tokens: on ? null : 0 })
  emit(id, { type: 'chatState', state: state(id) })
  return true
}

/** Start Claude on a chat without sending anything, for a command only it can answer (/mcp, /btw). */
/**
 * One start per chat at a time, waiting for the last Claude to leave first (two on one
 * chat would tangle it). Callers that arrive while one is pending share it and get the
 * same answer. A stop meanwhile, or an old Claude that will not leave, ends it at once
 * with false rather than leaving anyone waiting.
 */
const WAKES = new Map()              // chat id -> { promise, settle }
function wake (id, opts) {
  if (RUNS.has(id)) return Promise.resolve(true)
  const pending = WAKES.get(id)
  if (pending) return pending.promise
  let settle, fail
  const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject })
  const done = () => { if (WAKES.get(id) === w) WAKES.delete(id); clearTimeout(w.timer) }
  const w = { promise, settle: ok => { done(); settle(ok) }, fail: e => { done(); fail(e) } }
  WAKES.set(id, w)
  const go = () => {
    if (WAKES.get(id) !== w) return
    // a Claude that cannot start (not installed) says why, rather than just "no"
    try { if (!RUNS.has(id)) start(id, opts); w.settle(true) } catch (e) { w.fail(e) }
  }
  const old = STOPPING.get(id)
  if (old && old.exitCode === null && old.signalCode === null) {
    old.once('exit', () => { if (STOPPING.get(id) === old) STOPPING.delete(id); go() })
    try { old.kill() } catch {}
    w.timer = setTimeout(() => w.settle(false), 5000)
  } else go()
  return promise
}
const cancelWake = id => WAKES.get(id)?.settle(false)

/** The MCP servers this chat has, and whether each is connected. */
function mcpStatus (id, done) {
  const r = RUNS.get(id)
  if (!r) return done(null)
  control(r, { subtype: 'mcp_status' }, res => done(Array.isArray(res?.mcpServers) ? res.mcpServers.map(x => ({ name: String(x.name || ''), status: String(x.status || '') })) : null))
}

function stop (id, now) {
  DEFERRED.delete(id)                 // a send still waiting to start is cancelled too
  cancelWake(id)                      // and so is a start for /mcp or /btw, answered at once
  const r = RUNS.get(id)
  if (!r) return
  r.stopping = true
  // until it has really gone, a new Claude on this chat waits (see send)
  STOPPING.set(id, r.proc)
  r.proc.once('exit', () => { if (STOPPING.get(id) === r.proc) STOPPING.delete(id) })
  // out of the list at once: a message sent while it leaves starts a new Claude
  // rather than being written to one whose input is already closed
  if (RUNS.get(id) === r) RUNS.delete(id)
  // and known to have ended here, so it is not mistaken for running elsewhere
  ENDED.set(id, Date.now())
  OPTS.onChange(id)
  // the editor is closing or reloading: a timer would not outlive it, and a
  // Claude left behind carries on working where nobody can answer it
  if (now) { try { r.proc.kill() } catch {} return }
  try { r.proc.stdin.end() } catch {}
  // a Claude that does not leave when its input closes is told to
  setTimeout(() => { try { r.proc.kill() } catch {} }, 3000).unref?.()
}

/**
 * A chat whose tab was closed lets its Claude go: at once when idle, or once the
 * reply, question or background work it is on is done. Reopening starts a fresh
 * one, which reads the latest rules, memory and servers.
 */
function release (id) {
  const r = RUNS.get(id)
  if (!r) {
    const waiting = DEFERRED.get(id)
    if (waiting) waiting.release = true
    else cancelWake(id)
    return
  }
  if (r.busy || r.asks.size || r.bg.length) r.restart = true
  else stop(id)
}

function stopAll (now) {
  DEFERRED.clear()
  for (const id of [...WAKES.keys()]) cancelWake(id)
  for (const id of [...RUNS.keys()]) stop(id, now)
}

/** A Claude for this chat was just ended outside the runner. */
const markEnded = id => ENDED.set(id, Date.now())

/** A question or approval Claude is waiting on in this chat, if it is. */
const askOf = (id, requestId) => RUNS.get(id)?.asks.get(requestId) || null

/** The folder Claude runs in for this chat, when it runs here. */
const cwdOf = id => RUNS.get(id)?.cwd || ''

module.exports = { init, probe, seedKnown, cwdOf, askOf, has, endedRecently, liveMap, state, send, answer, interrupt, stopTask, taskOutput, cancelQueued, sideQuestion, setThinking, mcpStatus, release, wake, setModel, setMode, setEffort, stop, stopAll, markEnded }
