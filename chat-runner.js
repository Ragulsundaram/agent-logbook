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
const path = require('node:path')

const IDLE_MS = 15 * 60e3           // a chat nobody has used for this long is let go
const PARTIAL_MS = 90               // how often the half-written reply is sent on
const STDERR_KEEP = 4000

const RUNS = new Map()              // chat id -> its process and state
const ENDED = new Map()             // chat id -> when its Claude here last quit
let OPTS = { bin: () => null, emit: () => {}, onChange: () => {} }
// what the last Claude to start reported: offered before any chat has started
let KNOWN = { commands: [], models: [] }

function init (opts) { OPTS = { ...OPTS, ...opts } }

const has = id => RUNS.has(id)
// the live list lags a few seconds behind: a Claude that just quit here can still be listed as running
const endedRecently = id => Date.now() - (ENDED.get(id) || 0) < 10000

/** Running chats as the live list reads them: working, or waiting for you. */
function liveMap () {
  const out = {}
  // waiting: Claude has stopped to ask you something - neither working nor done
  for (const [id, r] of RUNS) out[id] = r.asks.size ? 'waiting' : r.busy ? 'busy' : 'idle'
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
    partial: r ? partialOf(r) : null,
    commands: KNOWN.commands,
    models: KNOWN.models,
  }
}

function partialOf (r) {
  const p = r.partial
  if (!p.text && !p.thinking && !p.tool) return null
  return { text: p.text, thinking: p.thinking, tool: p.tool }
}

function emit (id, m) { OPTS.emit({ ...m, id }) }

/**
 * Start Claude on a chat. `fresh` makes a new chat with this id, `forkOf`
 * branches a new chat with this id off another one, and otherwise the chat
 * is resumed where it left off.
 */
function start (id, { cwd, fresh, forkOf, model, mode, effort } = {}) {
  const bin = OPTS.bin()
  if (!bin) throw new Error('Claude Code was not found. Install it, or open a terminal once so the logbook can find it.')
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio']
  if (forkOf) args.push('--resume', forkOf, '--fork-session', '--session-id', id)
  else if (fresh) args.push('--session-id', id)
  else args.push('--resume', id)
  if (model) args.push('--model', model)
  if (mode) args.push('--permission-mode', mode)
  if (effort) args.push('--effort', effort)
  // an npm-installed claude is a node script: node sits beside it, and an
  // editor started from the Dock does not have your shell's PATH
  const env = { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH || ''}` }
  // started from inside a Claude session, the child would think it is nested
  delete env.CLAUDECODE
  const proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const r = {
    id, cwd, proc, buf: '', err: '', busy: false, model: model || '', mode: mode || '', effort: effort || '',
    asks: new Map(), partial: { text: '', thinking: false, tool: '' }, partialTimer: null,
    idle: null, seq: 0, restart: false,
    pending: 0,                     // messages sent that Claude has not finished answering
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
      if (r.stopping && RUNS.has(id) && RUNS.get(id) !== r) continue
      try { onLine(r, m) } catch {}
    }
  })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', d => { r.err = (r.err + d).slice(-STDERR_KEEP) })
  // EPIPE when Claude has quit with a write on its way: the exit handler says so
  proc.stdin.on('error', () => {})
  // a claude that could not start at all raises only 'error', one that ran
  // raises 'exit': either way the chat is told once
  proc.on('error', e => { r.err += '\n' + e.message; finish(1) })
  proc.on('exit', code => finish(code))
  function finish (code) {
    if (r.ended) return
    r.ended = true
    clearTimeout(r.idle); clearTimeout(r.partialTimer)
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
  write(r, { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  armIdle(r)
  OPTS.onChange(id)
  return r
}

function write (r, obj) {
  try { r.proc.stdin.write(JSON.stringify(obj) + '\n') } catch {}
}

function control (r, request) {
  const request_id = `lb-${++r.seq}`
  write(r, { type: 'control_request', request_id, request })
  return request_id
}

function armIdle (r) {
  clearTimeout(r.idle)
  r.idle = setTimeout(() => {
    if (r.busy || r.asks.size) return armIdle(r)
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
        r.partial = { text: '', thinking: false, tool: '' }
        r.busy = true                 // a queued message's turn starting counts as working
      } else if (e.type === 'content_block_start') {
        const b = e.content_block || {}
        if (b.type === 'thinking' || b.type === 'redacted_thinking') r.partial.thinking = true
        if (b.type === 'tool_use') r.partial.tool = b.name || 'a tool'
        if (b.type === 'text' && r.partial.text) r.partial.text += '\n\n'
      } else if (e.type === 'content_block_delta') {
        const d = e.delta || {}
        if (d.type === 'text_delta') { r.partial.text += d.text || ''; r.partial.thinking = false }
        else if (d.type === 'thinking_delta') r.partial.thinking = true
      } else return
      flushPartial(r)
      return
    }
    case 'assistant':
      if (m.parent_tool_use_id) return
      // the whole message is in the transcript now; the view swaps the
      // half-written copy for it on its next read
      emit(r.id, { type: 'chatLanded' })
      OPTS.onWrite?.(r.id)
      return
    case 'user':
      if (!m.parent_tool_use_id) OPTS.onWrite?.(r.id)
      return
    case 'system':
      if (m.subtype === 'init') {
        r.actualModel = m.model || ''
        if (m.permissionMode) r.mode = m.permissionMode
        emit(r.id, { type: 'chatState', state: state(r.id), actualModel: r.actualModel })
      } else if (m.subtype === 'status' && m.permissionMode) {
        r.mode = m.permissionMode
        emit(r.id, { type: 'chatState', state: state(r.id) })
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
        }
        r.asks.set(m.request_id, ask)
        flushPartial(r, true)
        emit(r.id, { type: 'chatAsk', ask })
        OPTS.onChange(r.id)
        return
      }
      // nothing else is ours to answer: hooks and MCP servers run inside Claude
      write(r, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not supported by Agent Logbook' } })
      return
    }
    case 'control_cancel_request':
      if (r.asks.delete(m.request_id)) emit(r.id, { type: 'chatAskGone', requestId: m.request_id })
      return
    case 'control_response': {
      const res = m.response || {}
      if (res.request_id === 'init' && res.subtype === 'success') {
        const x = res.response || {}
        KNOWN = {
          commands: (x.commands || []).map(c => ({ name: String(c.name || ''), description: String(c.description || '').slice(0, 200), hint: String(c.argumentHint || '') })),
          models: (x.models || []).map(o => ({ value: String(o.value || ''), label: String(o.displayName || o.value || ''), note: String(o.description || ''), efforts: o.supportsEffort ? (o.supportedEffortLevels || []) : [] })),
        }
        emit(r.id, { type: 'chatState', state: state(r.id) })
      }
      return
    }
    case 'result': {
      // each message is answered as its own turn, with its own result: a chat
      // with a message still queued is still working. Stopping drops the queue.
      const stopped = m.subtype === 'error_during_execution' || m.terminal_reason === 'interrupted'
      r.pending = stopped ? 0 : Math.max(0, r.pending - 1)
      r.busy = r.pending > 0
      r.partial = { text: '', thinking: false, tool: '' }
      clearTimeout(r.partialTimer); r.partialTimer = null
      // an answer that was never given is moot once the turn has ended
      for (const k of r.asks.keys()) emit(r.id, { type: 'chatAskGone', requestId: k })
      r.asks.clear()
      if (r.busy) emit(r.id, { type: 'chatState', state: state(r.id) })   // on to the queued message
      else {
        emit(r.id, {
          type: 'chatDone',
          ms: m.duration_ms || 0,
          error: m.is_error ? String(m.result || m.subtype || 'Claude stopped with an error.').slice(0, 2000) : '',
          stopped,
        })
      }
      OPTS.onWrite?.(r.id)
      OPTS.onChange(r.id)
      armIdle(r)
      if (r.restart && !r.busy) { r.restart = false; stop(r.id) }
      return
    }
  }
}

/**
 * Send a message, starting Claude on the chat first if it is not running.
 * A message sent while Claude is still working waits its turn, as typing
 * ahead in the terminal does.
 */
function send (id, { text, images, cwd, fresh, forkOf, model, mode, effort }) {
  let r = RUNS.get(id)
  if (!r) r = start(id, { cwd, fresh, forkOf, model, mode, effort })
  const content = []
  for (const im of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })
  }
  if (text) content.push({ type: 'text', text })
  // Claude's input already closed (it quit on its own): say so, so the text goes back in the box
  if (!r.proc.stdin.writable) {
    emit(id, { type: 'chatError', error: 'Claude had stopped, so the message was not sent. It is back in the box: send it again.' })
    return
  }
  write(r, {
    type: 'user',
    message: { role: 'user', content: content.length === 1 && !images?.length ? text : content },
    parent_tool_use_id: null,
  })
  r.pending++
  r.busy = true
  armIdle(r)
  emit(id, { type: 'chatState', state: state(id) })
  OPTS.onChange(id)
}

/** Answer a permission prompt, a question or a plan. */
function answer (id, requestId, reply) {
  const r = RUNS.get(id)
  const ask = r?.asks.get(requestId)
  if (!ask) return false
  r.asks.delete(requestId)
  let response
  if (reply.allow) {
    // a question's answers go back inside its own input, as the terminal sends them
    const input = reply.answers && ask.kind === 'question' ? { ...ask.input, answers: reply.answers } : ask.input
    response = { behavior: 'allow', updatedInput: input }
    // "always allow" saves the rule Claude itself suggested, as the terminal's
    // "don't ask again" does
    if (reply.always && ask.suggestions.length) response.updatedPermissions = ask.suggestions
  } else {
    response = { behavior: 'deny', message: String(reply.message || 'The user declined this. Ask them what to do instead.') }
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
  control(r, { subtype: 'interrupt' })
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
  r.mode = mode
  control(r, { subtype: 'set_permission_mode', mode: mode || 'default' })
  emit(id, { type: 'chatState', state: state(id) })
}

/**
 * Effort is fixed when Claude starts, so a change restarts it - now if it is
 * idle, otherwise once the reply in progress is done.
 */
function setEffort (id, effort) {
  const r = RUNS.get(id)
  if (!r) return
  r.effort = effort
  if (r.busy || r.asks.size) r.restart = true
  else stop(id)
}

function stop (id, now) {
  const r = RUNS.get(id)
  if (!r) return
  r.stopping = true
  // out of the list at once: a message sent while it leaves starts a new Claude
  // rather than being written to one whose input is already closed
  if (RUNS.get(id) === r) RUNS.delete(id)
  // the editor is closing or reloading: a timer would not outlive it, and a
  // Claude left behind carries on working where nobody can answer it
  if (now) { try { r.proc.kill() } catch {} return }
  try { r.proc.stdin.end() } catch {}
  // a Claude that does not leave when its input closes is told to
  setTimeout(() => { try { r.proc.kill() } catch {} }, 3000).unref?.()
}

function stopAll (now) {
  for (const id of [...RUNS.keys()]) stop(id, now)
}

/** A Claude for this chat was just ended outside the runner. */
const markEnded = id => ENDED.set(id, Date.now())

module.exports = { init, has, endedRecently, liveMap, state, send, answer, interrupt, setModel, setMode, setEffort, stop, stopAll, markEnded }
