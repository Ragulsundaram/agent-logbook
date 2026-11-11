// Reads ~/.claude/projects. Read-only: the only file this module writes is its own
// cache in ~/.claude/.chistory-cache.json.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const HOME = os.homedir()
const PROJECTS = path.join(HOME, '.claude', 'projects')
const CACHE_FILE = path.join(HOME, '.claude', '.chistory-cache.json')

// Claude keeps ~/.claude/projects readable by you alone, but ~/.claude itself is
// open to every account on the machine. What we keep there - titles, the full-text
// search index, copies of chats - is the same private text, so it gets the same lock.
// The mode on a write only applies to a new file, hence the chmod.
function writePrivate (file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch {}
}
const mkdirPrivate = dir => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700) } catch {} }
// Bump whenever a summary field changes shape. A cache written by an older build is
// then ignored rather than quietly feeding the new code fields it never wrote.
const CACHE_V = 16
const VSDB = path.join(HOME, 'Library', 'Application Support', 'Cursor',
  'User', 'globalStorage', 'state.vscdb')

const EDITS = ['Edit', 'Write', 'NotebookEdit']
const JUNK = /^\s*(<local-command|<command-|<system-reminder|Caveat: The messages below|\[Request interrupted)/

// ------------------------------------------------------------------ pricing
// Per-million-token list prices. Cache writes bill at 1.25x input, reads at 0.1x.
const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
}
// a name from a transcript used as an object key must not be one of Object's own
const safeKey = k => k === '__proto__' || k === 'constructor' || k === 'prototype' ? `${k}?` : k

function rateFor (model = '') {
  if (PRICING[model]) return PRICING[model]
  const m = String(model)
  if (m.includes('fable')) return PRICING['claude-fable-5']
  if (m.includes('haiku')) return PRICING['claude-haiku-4-5']
  if (m.includes('sonnet')) return PRICING['claude-sonnet-5']
  return { in: 5, out: 25 }
}
function costOf (model, u) {
  const r = rateFor(model)
  return (u.input || 0) * r.in / 1e6 + (u.output || 0) * r.out / 1e6 +
    (u.cacheWrite || 0) * r.in * 1.25 / 1e6 + (u.cacheRead || 0) * r.in * 0.1 / 1e6
}
function prettyModel (m = '') {
  if (!m || m === 'unknown' || m.startsWith('<')) return 'Other'
  return String(m).replace(/^claude-/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
    .replace(/^./, c => c.toUpperCase())
}

// ------------------------------------------------------------------ parsing
// Strip the harness noise Claude Code writes into the transcript:
// <system-reminder> blocks, local-command wrappers and caveat preambles.
// Cut by indexOf, not a lazy regex: text that opens a tag thousands of times and
// never closes it made the regex quadratic, seconds per message.
function cutBlocks (s, open, close) {
  let out = '', at = 0
  for (;;) {
    const i = s.indexOf(open, at)
    if (i < 0) return out + s.slice(at)
    const j = s.indexOf(close, i + open.length)
    if (j < 0) return out + s.slice(at)
    out += s.slice(at, i)
    at = j + close.length
  }
}
const clean = t => {
  let s = String(t || '')
  if (s.includes('<system-reminder>')) s = cutBlocks(s, '<system-reminder>', '</system-reminder>')
  if (s.includes('<local-command-')) {
    for (const k of ['stdout', 'stderr', 'caveat']) s = cutBlocks(s, `<local-command-${k}>`, `</local-command-${k}>`)
  }
  if (s.includes('<command-')) {
    for (const k of ['name', 'message', 'args']) s = cutBlocks(s, `<command-${k}>`, `</command-${k}>`)
  }
  return s.trim()
}

const textOf = m => {
  const c = m?.message?.content ?? m?.content
  if (typeof c === 'string') return clean(c)
  if (!Array.isArray(c)) return ''
  return clean(c.filter(b => b?.type === 'text').map(b => b.text).join('\n'))
}
const blocksOf = m => {
  const c = m?.message?.content ?? m?.content
  return Array.isArray(c) ? c : []
}

/**
 * Summarise a transcript, picking up where the last summary left off.
 *
 * Transcripts only ever grow, and a busy one is written to several times a
 * second - a 40MB file re-parsed in full on every write kept the host busy most
 * of the time it was running, which is what made clicks feel dead. With `prev`,
 * only the bytes added since are read; anything that does not look like an
 * append (the file shrank, or the previous summary predates the resume fields)
 * falls back to a full read.
 */
function summarise (file, prev, agent) {
  let size
  try { size = fs.statSync(file).size } catch { return null }
  const resume = prev && prev._off > 0 && prev._off <= size && prev.file === file
  let raw
  try {
    if (resume) {
      if (prev._off === size) return prev
      const fd = fs.openSync(file, 'r')
      const buf = Buffer.alloc(size - prev._off)
      fs.readSync(fd, buf, 0, buf.length, prev._off)
      fs.closeSync(fd)
      raw = buf
    } else raw = fs.readFileSync(file)
  } catch { return null }
  // only whole lines: a record still being written finishes next time
  const end = raw.lastIndexOf(10) + 1
  const consumed = end
  raw = raw.subarray(0, end).toString('utf8')

  const s = resume ? structuredClone(prev) : {
    id: path.basename(file, '.jsonl'), file,
    title: '', cwd: '', entrypoint: '', firstTs: 0, lastTs: 0,
    messages: 0, edits: 0, models: {}, days: {}, activeMs: 0,
    files: {}, ops: {}, turns: 0, modelTurns: {},
    branchParent: '', branchedTo: [], branches: [],
  }
  let custom = resume ? (s._custom || '') : ''
  let ai = resume ? (s._ai || '') : ''
  let prevTs = resume ? (s._prevTs || 0) : 0
  if (resume) s.title = s._first || ''
  // One API response is written as several lines - one per text or tool block -
  // and every one of them repeats the same usage. Summed per line that counted a
  // multi-part reply two or three times over; it is counted once per message id.
  // The repeats are not always adjacent (parallel tool calls interleave), so the
  // recent ids are carried across an incremental resume.
  const seen = new Set(resume ? (s._ids || []) : [])
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    // /branch records where it came from and where it went - keep both ends
    if (e.type === 'system' && e.subtype === 'local_command' && e.content) {
      const made = /Branched conversation[\s\S]*?session ([0-9a-f-]{36})/.exec(e.content)
      const from = /\/resume ([0-9a-f-]{36})/.exec(e.content)
      if (made) s.branchedTo.push(made[1])
      if (made && from) s.branchParent = from[1]
    }
    if (e.type === 'custom-title' && e.customTitle) { custom = e.customTitle; continue }
    if (e.type === 'ai-title' && e.aiTitle) { ai = e.aiTitle; continue }
    if (!s.cwd && e.cwd) s.cwd = e.cwd
    if (!s.entrypoint && e.entrypoint) s.entrypoint = e.entrypoint
    if (e.gitBranch && !s.branches.includes(e.gitBranch)) s.branches.push(e.gitBranch)

    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    let bucket = null, gap = 0
    if (ts) {
      if (!s.firstTs) s.firstTs = ts
      s.lastTs = Math.max(s.lastTs, ts)
      // Records are not strictly in time order - a sub-agent's lines can land after
      // the reply that spawned it. Without the forward check those gaps go negative
      // and eat the total.
      if (prevTs && ts > prevTs && ts - prevTs < 3e5) {
        s.activeMs += ts - prevTs
        gap = ts - prevTs                 // credited to the day the gap ended on
      }
      prevTs = ts
      const day = new Date(ts).toISOString().slice(0, 10)
      bucket = (s.days[day] ||= { tokens: 0, cost: 0, messages: 0, edits: 0, activeMs: 0,
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0, hours: {}, hourCost: {}, models: {} })
      bucket.activeMs += gap
    }
    // Claude marks the end of every turn ("Brewed for 2m 8s · done"); until the
    // next prompt, the chat is not working whatever the clock says
    if (e.type === 'system' && e.subtype === 'turn_duration') s.turnOpen = false
    if (e.type !== 'user' && e.type !== 'assistant') continue
    // a sub-agent's own file is all sidechain; only a session skips those lines
    if (e.isMeta || (e.isSidechain && !agent)) continue
    // a prompt or a reply opens a turn; a slash command's own output does not
    if (e.type === 'assistant' || !JUNK.test(textOf(e))) s.turnOpen = true

    const mid = e.type === 'assistant' ? e.message?.id : null
    const repeat = !!(mid && seen.has(mid))
    if (mid) seen.add(mid)

    if (!repeat) s.messages++
    if (bucket && !repeat) {
      bucket.messages++
      const h = new Date(ts).getHours()
      bucket.hours[h] = (bucket.hours[h] || 0) + 1
    }
    const harness = e.type === 'user' && !!harnessNote(e)
    if (e.type === 'user' && !s.title && !harness) {
      const t = textOf(e)
      if (t && !JUNK.test(t)) s.title = t.replace(/\s+/g, ' ').slice(0, 90)
    }
    if (e.type === 'user' && !harness) s.turns++
    if (e.type === 'assistant' && e.message?.model && !repeat) {
      const mk = safeKey(e.message.model)
      s.modelTurns[mk] = (s.modelTurns[mk] || 0) + 1
    }
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_use') continue
      if (EDITS.includes(b.name)) {
        s.edits++; if (bucket) bucket.edits++
        const f = b.input?.file_path || b.input?.notebook_path
        if (f) s.files[f] = (s.files[f] || 0) + 1
        const op = b.name === 'Write' ? 'write' : b.name === 'NotebookEdit' ? 'notebook' : 'edit'
        s.ops[op] = (s.ops[op] || 0) + 1
      } else if (b.name === 'Bash' && /\brm\s/.test(String(b.input?.command || ''))) {
        s.ops.delete = (s.ops.delete || 0) + 1
      }
    }
    const u = !repeat && e.message?.usage
    if (u) {
      const model = safeKey(e.message?.model || 'unknown')
      const acc = (s.models[model] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
      const d = {
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      }
      for (const k of Object.keys(d)) acc[k] += d[k]
      if (bucket) {
        const tot = d.input + d.output + d.cacheWrite + d.cacheRead
        const c = costOf(model, d)
        bucket.tokens += tot; bucket.cost += c
        bucket.in += d.input; bucket.out += d.output
        bucket.cacheRead += d.cacheRead; bucket.cacheWrite += d.cacheWrite
        const hh = new Date(ts).getHours()
        bucket.hourCost[hh] = (bucket.hourCost[hh] || 0) + c
        const bm = (bucket.models[model] ||= { tokens: 0, cost: 0 })
        bm.tokens += tot; bm.cost += c
      }
    }
  }
  // what is needed to carry on from here next time
  s._off = (resume ? prev._off : 0) + consumed
  s._first = s.title
  s._custom = custom; s._ai = ai; s._prevTs = prevTs
  s._ids = [...seen].slice(-600)
  s.title = custom || ai || s.title || ''
  s.tokens = Object.values(s.models).reduce((n, m) => n + m.input + m.output + m.cacheWrite + m.cacheRead, 0)
  s.cost = Object.entries(s.models).reduce((n, [m, u]) => n + costOf(m, u), 0)
  return s
}

/**
 * Re-read the chat list. Quick reuses the per-file cache and only re-parses what
 * changed on disk; deep throws the cache away and re-parses every transcript.
 */
function rescan (deep) {
  if (deep) { try { fs.unlinkSync(CACHE_FILE) } catch {} }
  return index(true).length
}

let memo = null, memoAt = 0
// ------------------------------------------------------------------ codex
// Codex keeps one JSONL per session under ~/.codex/sessions/YYYY/MM/DD. The
// records differ from Claude's but carry the same facts, so they are folded
// into the same summary shape and the rest of the extension never has to care.
//
// Two streams describe the same conversation: `response_item` is the canonical
// transcript, `event_msg` is the UI's running commentary and repeats it. Only
// response_item is read for messages; event_msg is read for token counts and
// applied patches, which appear nowhere else.

const CODEX = path.join(HOME, '.codex', 'sessions')
const CODEX_IMPORTS = path.join(HOME, '.codex', 'external_agent_session_imports.json')

/**
 * Codex can import a Claude transcript and replay it as a rollout of its own.
 * Those are copies of chats already indexed here, so they are skipped - on this
 * machine 49 of 53 rollouts are imports, and counting them would inflate the
 * list with duplicates rather than show anything new.
 */
function codexImported () {
  try {
    const raw = JSON.parse(fs.readFileSync(CODEX_IMPORTS, 'utf8'))
    return new Set((raw.records || []).map(r => r.imported_thread_id).filter(Boolean))
  } catch { return new Set() }
}

// the harness talks to itself through the user role too
const CODEX_JUNK = /^\s*<(environment_context|user_instructions|ide_opened_file|permissions instructions|turn_aborted)/

/** Every Codex rollout file. Nested year/month/day, so walk rather than list. */
function codexFiles () {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let names
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      if (n.isDirectory()) walk(path.join(dir, n.name), depth + 1)
      else if (n.name.startsWith('rollout-') && n.name.endsWith('.jsonl')) {
        out.push(path.join(dir, n.name))
      }
    }
  }
  walk(CODEX, 0)
  return out
}

const codexText = p => (p.content || [])
  .filter(c => c && (c.type === 'input_text' || c.type === 'output_text'))
  .map(c => c.text).join('\n').trim()

/** The same summary a Claude session produces, read out of a Codex rollout. */
function summariseCodex (file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  const s = {
    id: '', file, provider: 'codex',
    title: '', cwd: '', entrypoint: '', firstTs: 0, lastTs: 0,
    messages: 0, edits: 0, models: {}, days: {}, activeMs: 0,
    files: {}, ops: {}, turns: 0, modelTurns: {},
    branchParent: '', branchedTo: [], branches: [],
  }
  let model = '', prevTs = 0, lastTotal = null
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const p = e.payload || {}
    if (e.type === 'session_meta') {
      s.id = s.id || (/^[\w-]+$/.test(p.id || '') ? p.id : '')
      s.cwd = s.cwd || p.cwd || ''
      // the originator says where it was driven from, which is our entrypoint
      s.entrypoint = s.entrypoint || (p.source === 'vscode' ? 'codex-vscode' : 'codex-cli')
      continue
    }
    if (e.type === 'turn_context') { if (p.model) model = safeKey(String(p.model)); continue }

    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    let bucket = null, gap = 0
    if (ts) {
      if (!s.firstTs) s.firstTs = ts
      s.lastTs = Math.max(s.lastTs, ts)
      if (prevTs && ts > prevTs && ts - prevTs < 3e5) { s.activeMs += ts - prevTs; gap = ts - prevTs }
      prevTs = ts
      const day = new Date(ts).toISOString().slice(0, 10)
      bucket = (s.days[day] ||= { tokens: 0, cost: 0, messages: 0, edits: 0, activeMs: 0,
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0, hours: {}, hourCost: {}, models: {} })
      bucket.activeMs += gap
    }

    // usage is reported cumulatively, so each reading is differenced against
    // the one before it to get what that stretch of the session actually cost
    if (e.type === 'event_msg' && p.type === 'token_count') {
      const tot = p.info?.total_token_usage
      if (!tot) continue
      const d = {
        input: Math.max(0, (tot.input_tokens || 0) - (lastTotal?.input_tokens || 0)),
        output: Math.max(0, (tot.output_tokens || 0) - (lastTotal?.output_tokens || 0)),
        cacheRead: Math.max(0, (tot.cached_input_tokens || 0) - (lastTotal?.cached_input_tokens || 0)),
        cacheWrite: 0,
      }
      lastTotal = tot
      const acc = (s.models[model || 'codex'] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
      for (const k of Object.keys(d)) acc[k] += d[k]
      if (bucket) {
        const tot = d.input + d.output + d.cacheRead
        bucket.tokens += tot
        bucket.in += d.input; bucket.out += d.output; bucket.cacheRead += d.cacheRead
        const bm = (bucket.models[model || 'codex'] ||= { tokens: 0, cost: 0 })
        bm.tokens += tot
      }
      continue
    }

    // a patch is the only place Codex records what it did to a file
    if (e.type === 'event_msg' && p.type === 'patch_apply_end') {
      for (const [f, ch] of Object.entries(p.changes || {})) {
        s.edits++; if (bucket) bucket.edits++
        s.files[f] = (s.files[f] || 0) + 1
        const op = ch.type === 'add' ? 'write' : ch.type === 'delete' ? 'delete' : 'edit'
        s.ops[op] = (s.ops[op] || 0) + 1
      }
      continue
    }

    if (e.type !== 'response_item' || p.type !== 'message') continue
    if (p.role !== 'user' && p.role !== 'assistant') continue
    const text = clean(codexText(p))
    if (p.role === 'user' && (CODEX_JUNK.test(text) || JUNK.test(text))) continue

    s.messages++
    if (bucket) {
      bucket.messages++
      bucket.hours[new Date(ts).getHours()] = (bucket.hours[new Date(ts).getHours()] || 0) + 1
    }
    if (p.role === 'user') {
      s.turns++
      if (!s.title && text) s.title = text.replace(/\s+/g, ' ').slice(0, 90)
    } else if (model) s.modelTurns[model] = (s.modelTurns[model] || 0) + 1
  }
  if (!s.id) s.id = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-/, '')
  s.tokens = Object.values(s.models).reduce((n, m) => n + m.input + m.output + m.cacheWrite + m.cacheRead, 0)
  // Codex is billed against a ChatGPT plan rather than per token, and inventing
  // a rate would put a wrong number next to a real one. Tokens stand alone.
  s.cost = 0
  return s
}

/**
 * A chat's usage includes the sub-agents it spawned. They keep their own
 * transcripts beside the chat's, so a summary of the chat alone left out every
 * token they spent - on a week of agent-heavy work, more than a third of it.
 * Their usage and edits are folded in; their messages are not, since the
 * conversation is still the one you had.
 */
function withAgents (base, cache, next) {
  const dir = base.file.replace(/\.jsonl$/, '') + '/subagents'
  let names
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')) } catch { return base }
  if (!names.length) return base
  const out = structuredClone(base)
  out.agentTokens = 0; out.agentCost = 0
  for (const n of names) {
    const f = path.join(dir, n)
    let mt; try { mt = fs.statSync(f).mtimeMs } catch { continue }
    const hit = cache[f]
    const rec = hit && hit.mtime === mt ? hit : { mtime: mt, s: summarise(f, hit?.s, true) }
    if (!rec.s) continue
    next[f] = rec
    mergeUsage(out, rec.s)
    out.agentTokens += rec.s.tokens; out.agentCost += rec.s.cost
  }
  out.tokens = Object.values(out.models).reduce((n, m) => n + m.input + m.output + m.cacheWrite + m.cacheRead, 0)
  out.cost = Object.entries(out.models).reduce((n, [m, u]) => n + costOf(m, u), 0)
  return out
}

function mergeUsage (to, from) {
  for (const [m, u] of Object.entries(from.models || {})) {
    const acc = (to.models[m] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 })
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) acc[k] += u[k] || 0
  }
  for (const [day, b] of Object.entries(from.days || {})) {
    const t = (to.days[day] ||= { tokens: 0, cost: 0, messages: 0, edits: 0, activeMs: 0,
      in: 0, out: 0, cacheRead: 0, cacheWrite: 0, hours: {}, hourCost: {}, models: {} })
    for (const k of ['tokens', 'cost', 'edits', 'in', 'out', 'cacheRead', 'cacheWrite']) t[k] += b[k] || 0
    for (const [h, c] of Object.entries(b.hourCost || {})) t.hourCost[h] = (t.hourCost[h] || 0) + c
    for (const [m, v] of Object.entries(b.models || {})) {
      const bm = (t.models[m] ||= { tokens: 0, cost: 0 })
      bm.tokens += v.tokens; bm.cost += v.cost
    }
  }
  to.edits += from.edits || 0
  for (const [f, n] of Object.entries(from.files || {})) to.files[f] = (to.files[f] || 0) + n
  for (const [op, n] of Object.entries(from.ops || {})) to.ops[op] = (to.ops[op] || 0) + n
}

function index (force) {
  if (!force && memo && Date.now() - memoAt < 3000) return memo
  let cache = {}
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (raw && raw.v === CACHE_V) cache = raw.files || {}
  } catch {}
  const next = {}, out = []
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { memo = []; memoAt = Date.now(); return memo }
  for (const d of dirs) {
    const dir = path.join(PROJECTS, d)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      const file = path.join(dir, f)
      let mt; try { mt = fs.statSync(file).mtimeMs } catch { continue }
      const hit = cache[file]
      const rec = hit && hit.mtime === mt ? hit : { mtime: mt, s: summarise(file, hit?.s) }
      if (!rec.s) continue
      next[file] = rec
      out.push(withAgents(rec.s, cache, next))
    }
  }
  const imported = codexImported()
  for (const file of codexFiles()) {
    let mt; try { mt = fs.statSync(file).mtimeMs } catch { continue }
    const hit = cache[file]
    const rec = hit && hit.mtime === mt ? hit : { mtime: mt, s: summariseCodex(file) }
    if (!rec.s) continue
    next[file] = rec                                // cached either way, so the parse is not repeated
    if (!rec.s.messages || imported.has(rec.s.id)) continue
    out.push(rec.s)
  }
  try { writePrivate(CACHE_FILE, JSON.stringify({ v: CACHE_V, files: next })) } catch {}
  // a name we keep ourselves overrides the one read out of the file
  const titles = state().titles
  if (titles) {
    for (let i = 0; i < out.length; i++) {
      if (titles[out[i].id]) out[i] = { ...out[i], title: titles[out[i].id] }
    }
  }
  out.sort((a, b) => b.lastTs - a.lastTs)
  memo = out; memoAt = Date.now()
  return out
}

/**
 * Every chat's group, keyed by session id.
 *
 * Groups used to live only in the Claude Code extension's own store. That
 * extension stopped writing them, which took the groups with it, so they are
 * kept here now and its store is read only as a fallback for anything still
 * there.
 */
/** Every chat's group, keyed by session id. */
function groups () {
  const map = {}
  groupList().forEach((g, i) => {
    (g.sessionIds || []).forEach(id => { map[id] = { name: g.name, order: i } })
  })
  return map
}

const CC_KEY = 'Anthropic.claude-code'

/** Whatever the Claude Code extension still holds, if anything. */
function ccGroups () {
  if (!fs.existsSync(VSDB)) return {}
  try {
    const raw = execFileSync('sqlite3', [`file:${VSDB}?mode=ro`,
      `select value from ItemTable where key='${CC_KEY}';`],
      { encoding: 'utf8', maxBuffer: 1 << 24 })
    const blob = raw.trim() ? JSON.parse(raw) : {}
    const out = {}
    for (const [k, v] of Object.entries(blob)) {
      if (k.startsWith('sessionGroups:') && Array.isArray(v)) out[k.slice(14)] = v
    }
    return out
  } catch { return {} }
}

/**
 * Groups are one flat list across every folder and every CLI.
 *
 * They used to be kept per working directory, inherited from how the Claude
 * Code extension stored them. That made a group unreachable from a chat
 * started anywhere else - a Codex session in the repo root could not join a
 * group made from a session in a subfolder - for no benefit, since the chips
 * were never scoped to a folder in the first place. Anything still stored per
 * folder is merged in on first read.
 */
function groupList () {
  const st = state()
  if (Array.isArray(st.groupList)) return st.groupList
  const merged = []
  const add = list => {
    for (const g of list || []) {
      const at = merged.find(x => x.name === g.name)
      if (at) at.sessionIds = [...new Set([...(at.sessionIds || []), ...(g.sessionIds || [])])]
      else merged.push({ ...g, sessionIds: [...(g.sessionIds || [])] })
    }
  }
  for (const list of Object.values(st.groups || {})) add(list)
  for (const list of Object.values(ccGroups())) add(list)
  st.groupList = merged
  delete st.groups
  saveState(st)
  return merged
}

const groupsFor = () => groupList()

/**
 * Groups are written to our own state file.
 *
 * They used to be written into the Claude Code extension's storage row so its
 * sidebar would show them too. That is what lost them: VS Code owns that row,
 * keeps the whole thing in memory, and rewrites it wholesale whenever the
 * extension saves any key of its own. The version-check marker it wrote on
 * updating to 2.1.273 was enough to flush its in-memory copy over ours. An
 * outside writer cannot win that race, so we no longer enter it - its store is
 * still read, in case it has groups of its own, but never written.
 */
function saveGroups (list) {
  const st = state()
  st.groupList = list
  saveState(st)
  return true
}

const randomId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
})

/** Create a group, or move a chat into one (or out of all of them). */
function editGroups ({ create, rename, remove, assign, sessionId } = {}) {
  const list = groupList()
  if (create && !list.some(g => g.name === create)) {
    list.unshift({ id: randomId(), name: create, collapsed: false, sessionIds: [] })
  }
  if (rename?.from && rename?.to) {
    const g = list.find(x => x.name === rename.from)
    if (g) g.name = rename.to
  }
  if (remove) {
    const i = list.findIndex(g => g.name === remove)
    if (i >= 0) list.splice(i, 1)
  }
  if (assign !== undefined && sessionId) {
    for (const g of list) g.sessionIds = (g.sessionIds || []).filter(id => id !== sessionId)
    const target = assign ? list.find(g => g.name === assign) : null
    if (target) target.sessionIds.unshift(sessionId)
  }
  saveGroups(list)
  return list
}

// the pid of each running session, kept from the last liveSessions() call so a
// session can be traced back to the terminal that is actually hosting it
let LIVE_PIDS = {}

function liveSessions () {
  try {
    const raw = execFileSync(BIN.claude || 'claude', ['agents', '--json'],
      { encoding: 'utf8', timeout: 15000, env: binEnv() })
    const map = {}
    const pids = {}
    for (const a of JSON.parse(raw)) { map[a.sessionId] = a.status; pids[a.sessionId] = a.pid }
    LIVE_PIDS = pids
    return map
  } catch { return {} }
}

/**
 * The same, without holding the thread. `claude agents` takes ~160ms, and run
 * synchronously on a three-second timer it froze the host that often - every
 * click arriving in that window waited for it.
 */
// Where the claude CLI lives, as the extension found it. An editor opened from
// the Dock does not get your shell's PATH, so a bare "claude" can fail there -
// and then no running chat is ever recognised.
const BIN = {}
function setBin (name, file) { if (file) BIN[name] = file }
// an npm-installed claude is a node script, so node has to be findable too,
// and it sits in the same folder
const binEnv = () => BIN.claude
  ? { ...process.env, PATH: `${path.dirname(BIN.claude)}:${process.env.PATH || ''}` }
  : { ...process.env }

function liveSessionsAsync () {
  return new Promise(resolve => {
    require('node:child_process').execFile(BIN.claude || 'claude', ['agents', '--json'],
      { encoding: 'utf8', timeout: 15000, env: binEnv() }, (err, raw) => {
        if (err) return resolve(null)
        try {
          const map = {}, pids = {}
          for (const a of JSON.parse(raw)) { map[a.sessionId] = a.status; pids[a.sessionId] = a.pid }
          LIVE_PIDS = pids
          resolve(map)
        } catch { resolve(null) }
      })
  })
}

/**
 * Running Codex chats. Codex has no command that lists them, so each Codex
 * process is asked which session file it holds open; a file written in the
 * last few seconds is working, otherwise it is waiting for you. With no Codex
 * running this is one process listing and nothing more.
 */
function codexLiveAsync () {
  const run = (bin, args) => new Promise(resolve => require('node:child_process')
    .execFile(bin, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 24 }, (err, out) => resolve(err ? '' : out)))
  return run('ps', ['-Ao', 'pid=,command=']).then(async out => {
    const pids = out.split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .filter(m => /(^|\/)codex(-[\w-]+)?(\s|$)/.test(m[2]) && !/agent-logbook|mcp-server/.test(m[2]))
      .map(m => m[1])
    if (!pids.length) return {}
    const byFile = new Map(index().filter(r => r.provider === 'codex').map(r => [r.file, r]))
    const map = {}
    for (const pid of pids.slice(0, 8)) {
      const names = (await run('lsof', ['-p', pid, '-Fn'])).split('\n')
        .filter(l => l.startsWith('n') && /rollout-.*\.jsonl$/.test(l)).map(l => l.slice(1))
      for (const f of names) {
        const rec = byFile.get(f)
        if (!rec) continue
        let mt = 0; try { mt = fs.statSync(f).mtimeMs } catch {}
        map[rec.id] = Date.now() - mt < 12000 ? 'busy' : 'idle'
      }
    }
    return map
  })
}

/**
 * What each running chat is costing the machine, and what Claude left behind.
 *
 * A chat's cost is its claude process plus everything it started - the shell
 * commands, servers and tools beneath it - since that is what the laptop pays
 * for. A leftover is a command Claude started that is no longer under any
 * running session: the session ended or crashed and the command kept going.
 * Claude starts every command through a script in ~/.claude/shell-snapshots,
 * which is what marks one as Claude's even after its session is gone.
 */
function resourcesAsync () {
  return new Promise(resolve => {
    require('node:child_process').execFile('ps', ['-Ao', 'pid=,ppid=,rss=,%cpu=,etime=,command='],
      { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 8000 }, (err, out) => {
        if (err) return resolve(null)
        const rows = []
        for (const line of out.split('\n')) {
          const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
          if (m) rows.push({ pid: +m[1], ppid: +m[2], kb: +m[3], cpu: +m[4], up: m[5], cmd: m[6] })
        }
        const kids = new Map()
        for (const r of rows) {
          if (!kids.has(r.ppid)) kids.set(r.ppid, [])
          kids.get(r.ppid).push(r)
        }
        const byPid = new Map(rows.map(r => [r.pid, r]))
        const under = pid => {
          const out = [], stack = [pid]
          while (stack.length) {
            const p = stack.pop()
            const r = byPid.get(p)
            if (r) out.push(r)
            for (const k of kids.get(p) || []) stack.push(k.pid)
          }
          return out
        }
        const sessions = {}
        const owned = new Set()
        for (const [id, pid] of Object.entries(LIVE_PIDS)) {
          const tree = under(pid)
          for (const r of tree) owned.add(r.pid)
          sessions[id] = {
            mb: Math.round(tree.reduce((n, r) => n + r.kb, 0) / 1024),
            cpu: Math.round(tree.reduce((n, r) => n + r.cpu, 0)),
            procs: tree.length,
          }
        }
        const leftovers = []
        for (const r of rows) {
          if (owned.has(r.pid) || !r.cmd.includes('.claude/shell-snapshots')) continue
          // the script itself is only the wrapper - name the command it ran
          const ran = /eval '([\s\S]*?)' < \/dev\/null/.exec(r.cmd)
          const tree = under(r.pid)
          leftovers.push({
            pid: r.pid, up: r.up,
            mb: Math.round(tree.reduce((n, x) => n + x.kb, 0) / 1024),
            cpu: Math.round(tree.reduce((n, x) => n + x.cpu, 0)),
            cmd: (ran ? ran[1] : r.cmd).replace(/'"'"'/g, "'").slice(0, 300),
          })
        }
        resolve({ sessions, leftovers, at: Date.now() })
      })
  })
}

/** Which session a running claude process belongs to, if any. */
const sessionForPid = pid => Object.keys(LIVE_PIDS).find(id => LIVE_PIDS[id] === pid) || null
/** Every session currently running, with its pid. */
const livePids = () => ({ ...LIVE_PIDS })

/** Which process is running a session right now, if any. */
const livePid = id => LIVE_PIDS[id] || null

// ------------------------------------------------------------------ plan limits
// ~/.claude.json only holds whatever Claude Code last happened to fetch, which can
// be hours old. Ask the same endpoint Claude Code asks, with the same OAuth token,
// and keep our own short-lived copy. Falls back to the cached file if that fails.
const USAGE_FILE = path.join(HOME, '.claude', '.chistory-usage.json')

function oauthToken () {
  try {
    const raw = execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 5000 })
    const t = JSON.parse(raw)?.claudeAiOauth?.accessToken
    if (t) return t
  } catch {}
  try {
    const raw = fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8')
    return JSON.parse(raw)?.claudeAiOauth?.accessToken || null
  } catch {}
  return null
}

// The endpoint rate-limits, and every open view used to ask on its own timer. One
// request at a time, never more often than once a minute, and back off on refusal.
const MIN_GAP = 60000
let inflight = null
let coolUntil = 0
let lastError = ''

const usageState = () => ({ coolUntil, lastError })

/** GET api.anthropic.com/api/oauth/usage and cache it. Resolves to true if refreshed. */
function refreshUsage (maxAgeMs = MIN_GAP, force) {
  if (inflight) return inflight
  if (Date.now() < coolUntil) return Promise.resolve(false)
  // a button press may skip the polling floor, but never the back-off
  const wait = force ? maxAgeMs : Math.max(maxAgeMs, MIN_GAP)
  inflight = doRefresh(wait).finally(() => { inflight = null })
  return inflight
}

function doRefresh (maxAgeMs) {
  return new Promise(resolve => {
    try {
      const have = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
      if (Date.now() - (have.fetchedAt || 0) < maxAgeMs) return resolve(false)
    } catch {}
    const token = oauthToken()
    if (!token) { lastError = 'no Claude credentials found'; return resolve(false) }
    const req = require('node:https').request({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-history-extension',
      },
      timeout: 8000,
    }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => {
        if (res.statusCode === 429) {
          // honour Retry-After when it is offered, otherwise sit out five minutes
          const after = Number(res.headers['retry-after']) * 1000
          coolUntil = Date.now() + (after > 0 ? after : 3e5)
          lastError = 'rate limited by Anthropic'
          return resolve(false)
        }
        if (res.statusCode !== 200) {
          coolUntil = Date.now() + 12e4
          lastError = `usage request failed (${res.statusCode})`
          return resolve(false)
        }
        try {
          const data = JSON.parse(body)
          writePrivate(USAGE_FILE, JSON.stringify({ fetchedAt: Date.now(), data }))
          lastError = ''
          resolve(true)
        } catch { lastError = 'unreadable usage response'; resolve(false) }
      })
    })
    req.on('error', e => { coolUntil = Date.now() + 6e4; lastError = e.message; resolve(false) })
    req.on('timeout', () => { req.destroy(); coolUntil = Date.now() + 6e4; lastError = 'usage request timed out'; resolve(false) })
    req.end()
  })
}

const pct = v => {
  const n = Number(v) || 0
  return n > 0 && n < 1 && !Number.isInteger(n) ? n * 100 : n
}
/** Whichever reading is newer: our own fetch, or the one Claude Code cached. */
function usageSource () {
  let live = null, cached = null
  try {
    const f = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
    if (f.data) live = { at: f.fetchedAt || 0, u: f.data, fresh: true }
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
    const c = raw.cachedUsageUtilization
    if (c) cached = { at: c.fetchedAtMs || 0, u: c.utilization, fresh: false }
  } catch {}
  if (live && cached) return live.at >= cached.at ? live : cached
  return live || cached
}

/**
 * Codex reports its own quota inside the rollout, on every usage record: a
 * 5-hour window and a 7-day one. There is no endpoint to ask, so the newest
 * reading any session happened to write is the best available - and a reading
 * whose window has already reset is reported as stale rather than as fact.
 */
function codexLimits () {
  const files = codexFiles()
  if (!files.length) return []
  let best = null, bestAt = 0
  // newest file first: the last reading in it is the most recent one there is
  for (const f of files.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch { return 0 }
  }).slice(0, 5)) {
    let raw; try { raw = fs.readFileSync(f, 'utf8') } catch { continue }
    if (!raw.includes('rate_limits')) continue
    for (const line of raw.split('\n')) {
      if (!line.includes('rate_limits')) continue
      let e; try { e = JSON.parse(line) } catch { continue }
      const rl = e.payload?.rate_limits
      if (!rl) continue
      const at = e.timestamp ? Date.parse(e.timestamp) : 0
      if (at >= bestAt) { bestAt = at; best = rl }
    }
    if (best) break
  }
  if (!best) return []
  const win = (w, key, label) => {
    if (!w) return null
    const resetsAt = w.resets_at ? w.resets_at * 1000 : 0
    return {
      key, label,
      percent: Math.round(pct(w.used_percent || 0)),
      severity: 'normal',
      resetsAt,
      active: false,
      // the window has turned over since this was written, so the figure is history
      stale: !resetsAt || resetsAt < Date.now(),
      readAt: bestAt,
    }
  }
  return [win(best.primary, 'codex_session', 'Codex 5h'),
    win(best.secondary, 'codex_weekly', 'Codex 7d')].filter(Boolean)
}

function limits () {
  try {
    const src = usageSource()
    const u = src ? { fetchedAtMs: src.at, utilization: src.u } : null
    const list = u?.utilization?.limits || []
    const label = l => l.kind === 'session' ? 'Claude 5h'
      : l.scope?.model?.display_name ? `${l.scope.model.display_name} 7d`
      : l.group === 'weekly' ? 'Claude 7d' : l.kind
    return {
      fetchedAt: u?.fetchedAtMs || 0,
      ...usageState(),
      items: list.map(l => {
        // a limit without its own reset time takes it from the matching window
        const win = l.kind === 'session' ? u.utilization.five_hour : l.kind === 'weekly_all' ? u.utilization.seven_day : null
        const at = l.resets_at || win?.resets_at
        const resetsAt = at ? Date.parse(at) || 0 : 0
        return {
          key: l.kind, label: label(l),
          // The field arrives either as 0-100 or as a 0-1 fraction; a whole number
          // is always read as a percentage so "1" never becomes "100%".
          percent: Math.round(pct(l.percent)),
          severity: l.severity || 'normal',
          resetsAt,
          active: !!l.is_active,
          // a cached reading from before its window reset is history, not the current figure
          stale: resetsAt > 0 && resetsAt < Date.now(),
        }
      }).concat(codexLimits()),
    }
  } catch { return { fetchedAt: 0, items: codexLimits(), ...usageState() } }
}

function memories () {
  const out = []
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS) } catch { return out }
  for (const d of dirs) {
    const mem = path.join(PROJECTS, d, 'memory')
    let files = []
    try { files = fs.readdirSync(mem).filter(f => f.endsWith('.md')) } catch { continue }
    for (const f of files) {
      const p = path.join(mem, f)
      let body = '', st
      try { body = fs.readFileSync(p, 'utf8'); st = fs.statSync(p) } catch { continue }
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body)
      const meta = {}
      if (fm) for (const l of fm[1].split('\n')) {
        const m = /^(\w[\w-]*):\s*(.*)$/.exec(l.trim())
        if (m) meta[m[1]] = m[2]
      }
      const slug = meta.name || f.replace(/\.md$/, '')
      out.push({
        id: `${d}/${f}`, path: p, provider: 'claude',
        project: projectName(d.replace(/^-/, '/').replace(/-/g, '/')),
        name: slug,
        // a filename slug is not a heading - make it read like one
        title: slug.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()),
        type: (meta.type || '').split('|')[0].trim() || (f === 'MEMORY.md' ? 'index' : 'note'),
        description: meta.description || '',
        isIndex: f === 'MEMORY.md',
        body: fm ? body.slice(fm[0].length).trim() : body,
        mtime: st.mtimeMs,
      })
    }
  }
  out.push(...codexMemories(), ...standingInstructions())
  return out.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Codex keeps its own memories under ~/.codex/memories. Same markdown, same
 * frontmatter convention, so they are read the same way. The folder is often
 * empty - Codex only writes there when asked to remember something.
 */
function codexMemories () {
  const root = path.join(HOME, '.codex', 'memories')
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let names
    try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      const p = path.join(dir, n.name)
      if (n.isDirectory()) { walk(p, depth + 1); continue }
      if (!n.name.endsWith('.md')) continue
      const m = readNote(p, 'codex')
      if (m) { m.project = 'Codex'; out.push(m) }
    }
  }
  walk(root, 0)
  return out
}

/**
 * The standing instructions each CLI reads at the start of every session -
 * CLAUDE.md and AGENTS.md. Not memories in the sense of things learned, but
 * the same question is being asked of the tab: what does it already know?
 */
function standingInstructions () {
  const out = []
  const add = (file, provider, title) => {
    const m = readNote(file, provider)
    if (!m) return
    m.title = title
    m.type = 'instructions'
    m.project = provider === 'codex' ? 'Codex' : 'Claude'
    m.description = m.description || 'Read at the start of every session'
    out.push(m)
  }
  add(path.join(HOME, '.claude', 'CLAUDE.md'), 'claude', 'Global instructions')
  add(path.join(HOME, '.codex', 'AGENTS.md'), 'codex', 'Global instructions')
  return out
}

/** One markdown note with optional frontmatter, in the shape the tab renders. */
function readNote (file, provider) {
  let body = '', st
  try { body = fs.readFileSync(file, 'utf8'); st = fs.statSync(file) } catch { return null }
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  const meta = {}
  if (fm) for (const l of fm[1].split('\n')) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(l.trim())
    if (m) meta[m[1]] = m[2]
  }
  const base = path.basename(file, '.md')
  const slug = meta.name || base
  return {
    id: file, path: file, provider,
    project: '~', name: slug,
    title: slug.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()),
    type: (meta.type || '').split('|')[0].trim() || 'note',
    description: meta.description || '',
    isIndex: false,
    body: fm ? body.slice(fm[0].length).trim() : body,
    mtime: st.mtimeMs,
  }
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const dataUri = file => {
  const ext = path.extname(file).slice(1).toLowerCase()
  return `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`
}

// ------------------------------------------------------------------ search
// 389MB of transcripts, so the cheap test runs first: a raw byte scan of the file
// rules out the ones that cannot match before anything is parsed.
const SNIP = 90

function snippet (text, at, needle) {
  const from = Math.max(0, at - SNIP)
  const to = Math.min(text.length, at + needle.length + SNIP)
  return (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '')
}

/**
 * Find a phrase anywhere in the messages, tool names or code of every chat.
 * Returns chats newest first, each with its first few matching lines.
 */
/**
 * Reading every transcript takes a second or two, and the chats that match are
 * found one at a time along the way. `onChat` hands each one over as soon as it
 * is complete, so results can be shown as they are found rather than all at the
 * end; the return value is the same either way.
 */
// ------------------------------------------------------------------ search index
// Searching used to re-read every transcript on every query - over half a
// gigabyte here - when all a search can match is the message text and tool
// inputs, about 21MB of it. That text is pulled out once into an index, kept in
// memory and on disk, and topped up as transcripts grow by reading only the
// bytes added since, the same way the summaries are. A search then scans the
// index rather than the disk.
const SEARCH_FILE = path.join(HOME, '.claude', '.chistory-search.json')
const SEARCH_V = 2
let SIDX = null
let sidxSave = null

function searchIndex () {
  if (SIDX) return SIDX
  try {
    const raw = JSON.parse(fs.readFileSync(SEARCH_FILE, 'utf8'))
    if (raw && raw.v === SEARCH_V) SIDX = raw.files
  } catch {}
  SIDX = SIDX || {}
  return SIDX
}

/** Write the index back to disk once things go quiet, not on every change. */
function saveSearchIndexSoon () {
  if (sidxSave) return
  sidxSave = setTimeout(() => {
    sidxSave = null
    try {
      const tmp = SEARCH_FILE + '.tmp'
      writePrivate(tmp, JSON.stringify({ v: SEARCH_V, files: SIDX }))
      fs.renameSync(tmp, SEARCH_FILE)
    } catch {}
  }, 30000)
  if (sidxSave.unref) sidxSave.unref()
}

/** The searchable part of some transcript lines: message text, and tool calls. */
function searchEntries (raw, provider) {
  const out = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (provider === 'codex') {
      const p = e.payload || {}
      if (e.type !== 'response_item' || p.type !== 'message') continue
      if (p.role !== 'user' && p.role !== 'assistant') continue
      const t = clean(codexText(p))
      if (t) out.push({ r: p.role, ts: e.timestamp || '', t })
      continue
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue
    if (e.isSidechain) continue
    const note = harnessNote(e)
    if (note) {
      // what an agent reported, or another session said, is worth finding -
      // indexed under its own name rather than as something you typed
      const t = [note.text, note.detail].filter(Boolean).join('\n\n')
      if (t) out.push({ r: note.kind === 'peer' ? 'session' : 'agent', ts: e.timestamp || '', t })
      continue
    }
    const t = textOf(e)
    const tools = blocksOf(e).filter(b => b?.type === 'tool_use')
      .map(b => ({ n: b.name, b: JSON.stringify(b) }))
    if (!t && !tools.length) continue
    const entry = { r: e.type, ts: e.timestamp || '' }
    if (t) entry.t = t
    if (tools.length) entry.x = tools
    out.push(entry)
  }
  return out
}

/** One chat's entries, brought up to date by reading only what was appended. */
function searchEntriesFor (s) {
  const idx = searchIndex()
  let st; try { st = fs.statSync(s.file) } catch { return [] }
  const prev = idx[s.file]
  if (prev && prev.mtime === st.mtimeMs) return prev.e
  const resume = prev && prev.off > 0 && prev.off <= st.size
  let buf
  try {
    if (resume) {
      const fd = fs.openSync(s.file, 'r')
      buf = Buffer.alloc(st.size - prev.off)
      fs.readSync(fd, buf, 0, buf.length, prev.off)
      fs.closeSync(fd)
    } else buf = fs.readFileSync(s.file)
  } catch { return prev ? prev.e : [] }
  const end = buf.lastIndexOf(10) + 1             // only whole lines; the rest next time
  const added = searchEntries(buf.subarray(0, end).toString('utf8'), s.provider)
  const e = resume ? prev.e.concat(added) : added
  idx[s.file] = { mtime: st.mtimeMs, off: (resume ? prev.off : 0) + end, e }
  saveSearchIndexSoon()
  return e
}

/** Build or refresh the index for every chat - run in the background at startup. */
function warmSearch () {
  for (const s of index()) searchEntriesFor(s)
}

/**
 * Searching hands each chat over as soon as its hits are known, via `onChat`,
 * so results can be shown as they are found; the return value is the same.
 */
// `sanitize` (used by the MCP server to redact secrets) runs BEFORE matching,
// not just before display: matching the raw text and hiding it afterwards lets
// a caller read a secret out letter by letter from which chats come back.
function search (q, { limit = 60, perChat = 6, onChat = null, sanitize = null } = {}) {
  const started = Date.now()
  const needle = String(q || '').trim().toLowerCase()
  const all = index()
  if (needle.length < 2) {
    return { q: needle, chats: [], scanned: 0, total: all.length, matches: 0, ms: 0, truncated: false }
  }
  // case-insensitive without lowercasing anything: a regex stops at the first hit
  const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

  const chats = []
  let scanned = 0, matches = 0
  for (const s of all) {
    if (chats.length >= limit) {
      return { q: needle, chats, scanned, total: all.length, matches,
        ms: Date.now() - started, truncated: true }
    }
    const entries = searchEntriesFor(s)
    scanned++
    const hits = []
    let total = 0
    for (const en of entries) {
      const t = en.t && sanitize ? sanitize(en.t) : en.t
      const where = t ? t.search(rx) : -1
      if (where >= 0) {
        total++
        if (hits.length < perChat) hits.push({ role: en.r, ts: en.ts, text: snippet(t, where, needle) })
        continue
      }
      // not in the prose - a tool name or its arguments
      const tool = en.x && en.x.find(x => rx.test(sanitize ? sanitize(x.b) : x.b))
      if (tool) {
        total++
        if (hits.length < perChat) hits.push({ role: en.r, ts: en.ts, tool: tool.n, text: `used ${tool.n}` })
      }
    }
    if (hits.length) {
      matches += total
      const chat = {
        id: s.id, title: s.title || '(untitled)', project: projectName(s.cwd), cwd: s.cwd,
        provider: s.provider || 'claude',
        lastTs: s.lastTs, messages: s.messages, cost: s.cost, total, hits,
      }
      chats.push(chat)
      if (onChat) onChat(chat, { scanned, matches, total: all.length })
    }
  }
  return { q: needle, chats, scanned, total: all.length, matches,
    ms: Date.now() - started, truncated: false }
}

/** "[Image: source: /path/to/shot.png]" -> a loadable image, when the file is still there. */
function pastedImages (text) {
  const out = []
  for (const m of String(text || '').matchAll(/\[Image: source: ([^\]\n]+\.(?:png|jpe?g|gif|webp))\]/gi)) {
    const file = m[1].trim()
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || st.size > 6e6) continue
      out.push({ src: dataUri(file), path: file })
    } catch {}                                   // the cache prunes old screenshots
  }
  return out
}

// The last transcript is kept whole, images and all. Sending every screenshot as
// base64 in one message was 36MB for a long chat; the webview asks for them one at
// a time instead, and this is what answers those requests.
let full = null

/** One inlined image, fetched on demand by the webview. */
/** Load whichever transcript a key names - a session's, or one agent's inside it. */
function ensureFull (key) {
  if (full && full.id === key) return
  const [id, agentId] = String(key).split('#')
  if (agentId) agentTranscript(id, agentId); else transcript(id)
}

/** `part`: the request came from the partial first copy, whose turns are numbered from its own start. */
const turnsFor = (id, part) => part && partCopy?.id === id ? partCopy.turns : (ensureFull(id), full?.turns)
function imageAt (id, ti, ii, part) {
  return turnsFor(id, part)?.[ti]?.images?.[ii]?.src || null
}

const lines = s => (s ? String(s).split('\n').length : 0)
const nfmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n)

/** What an edit did to a file, as far as the transcript records it. */
function editDelta (name, input = {}) {
  if (name === 'Write') return { adds: lines(input.content), dels: 0 }
  if (name === 'Edit') {
    const hits = input.replace_all ? 1 : 1                 // the transcript records one call
    return { adds: lines(input.new_string) * hits, dels: lines(input.old_string) * hits }
  }
  if (name === 'NotebookEdit') return { adds: lines(input.new_source), dels: 0 }
  return { adds: 0, dels: 0 }
}

/**
 * Everything the dashboard draws, in one pass over the index. Costs are at API
 * list prices, which is what a subscription would have cost on the API - not what
 * you were billed.
 */
/**
 * Both CLIs are measured together, but only Claude has a price: Codex bills
 * against a plan and reports none. Every page that shows a cost therefore also
 * shows the split, so a token total that is part unpriced says so rather than
 * implying the whole of it was free.
 */
const SOURCES = ['claude', 'codex']
const sourceOf = s => (s.provider === 'codex' ? 'codex' : 'claude')
const emptySplit = () => ({ claude: { tokens: 0, cost: 0, sessions: 0, messages: 0 },
  codex: { tokens: 0, cost: 0, sessions: 0, messages: 0 } })

function dashboard (days = 30) {
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
  const cutoff = days ? day(days - 1) : '0000-00-00'
  const today = day(0)

  const totals = { tokens: 0, cost: 0, messages: 0, edits: 0, activeMs: 0, sessions: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
  const bySource = emptySplit()
  const byDay = {}, byModel = new Map(), byProject = new Map(), byHour = {}, byWeekday = {}
  const byHourCost = {}, files = new Map(), ops = {}
  const chats = []

  // "all time" has no fixed length, so seed from the oldest day that has anything
  let span = days
  if (!span) {
    let oldest = today
    for (const s of index()) for (const d of Object.keys(s.days)) if (d < oldest) oldest = d
    span = Math.min(370, Math.round((Date.parse(today) - Date.parse(oldest)) / 864e5) + 1)
  }
  for (let i = span - 1; i >= 0; i--) {
    byDay[day(i)] = { tokens: 0, cost: 0, messages: 0, edits: 0, sessions: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }

  for (const s of index()) {
    let touched = false, tokens = 0, cost = 0
    const src = bySource[sourceOf(s)]
    for (const [d, b] of Object.entries(s.days)) {
      if (d < cutoff || d > today) continue
      touched = true
      tokens += b.tokens; cost += b.cost
      src.tokens += b.tokens; src.cost += b.cost; src.messages += b.messages
      totals.tokens += b.tokens; totals.cost += b.cost
      totals.messages += b.messages; totals.edits += b.edits
      totals.activeMs += b.activeMs || 0
      const t = byDay[d]
      if (t) {
        t.tokens += b.tokens; t.cost += b.cost; t.messages += b.messages; t.edits += b.edits
        t.input += b.in || 0; t.output += b.out || 0
        t.cacheRead += b.cacheRead || 0; t.cacheWrite += b.cacheWrite || 0
        t.sessions++
      }
      for (const [h, n] of Object.entries(b.hours || {})) byHour[h] = (byHour[h] || 0) + n
      for (const [h, c] of Object.entries(b.hourCost || {})) byHourCost[h] = (byHourCost[h] || 0) + c
      const wd = new Date(d + 'T12:00').getDay()
      byWeekday[wd] = (byWeekday[wd] || 0) + b.tokens
      for (const [m, v] of Object.entries(b.models)) {
        const acc = byModel.get(m) || { tokens: 0, cost: 0 }
        acc.tokens += v.tokens; acc.cost += v.cost
        byModel.set(m, acc)
      }
    }
    if (!touched) continue
    totals.sessions++
    totals.turns += s.turns || 0
    for (const [f, n] of Object.entries(s.files || {})) files.set(f, (files.get(f) || 0) + n)
    for (const [o, n] of Object.entries(s.ops || {})) ops[o] = (ops[o] || 0) + n
    for (const [m, n] of Object.entries(s.modelTurns || {})) {
      if (m.startsWith('<')) continue
      const acc = byModel.get(m) || { tokens: 0, cost: 0, turns: 0 }
      acc.turns = (acc.turns || 0) + n
      byModel.set(m, acc)
    }
    for (const u of Object.values(s.models)) {
      totals.input += u.input; totals.output += u.output
      totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite
    }
    src.sessions++
    const name = projectName(s.cwd)
    const p = byProject.get(name) || { name, sessions: 0, tokens: 0, cost: 0, edits: 0, activeMs: 0 }
    p.sessions++; p.tokens += tokens; p.cost += cost; p.edits += s.edits; p.activeMs += s.activeMs
    byProject.set(name, p)
    // cache hit rate and unit costs are what make one chat cheaper than another
    const read = Object.values(s.models).reduce((n, u) => n + u.cacheRead, 0)
    const inp = Object.values(s.models).reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
    chats.push({ id: s.id, title: s.title || '(untitled)', project: name,
      firstTs: s.firstTs, lastTs: s.lastTs,
      tokens, cost, messages: s.messages, edits: s.edits, activeMs: s.activeMs,
      cacheHit: inp ? read / inp : 0,
      costPerMsg: s.messages ? cost / s.messages : 0,
      tokensPerMsg: s.messages ? tokens / s.messages : 0 })
  }

  const models = [...byModel.entries()]
    .map(([id, v]) => ({ id, name: prettyModel(id), ...v }))
    .filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens)

  const readAll = totals.cacheRead
  const inAll = totals.input + totals.cacheRead + totals.cacheWrite
  return {
    days, totals, byDay, byHour, byWeekday, byHourCost,
    models,
    projects: [...byProject.values()].sort((a, b) => b.cost - a.cost),
    chats: chats.sort((a, b) => b.cost - a.cost).slice(0, 60),
    files: [...files.entries()].map(([path, n]) => ({ path, n }))
      .sort((a, b) => b.n - a.n).slice(0, 15),
    ops,
    heatmap: heatmap(),
    efficiency: {
      cacheHit: inAll ? readAll / inAll : 0,
      costPerMsg: totals.messages ? totals.cost / totals.messages : 0,
      tokensPerMsg: totals.messages ? totals.tokens / totals.messages : 0,
      activeMs: totals.activeMs,
    },
    bySource,
    limits: limits(),
    streaks: streaks(),
    generatedAt: Date.now(),
  }
}

/** A year of daily tokens, for the calendar heatmap. */
function heatmap () {
  const out = {}
  const from = new Date(Date.now() - 364 * 864e5).toISOString().slice(0, 10)
  for (const s of index()) {
    for (const [d, b] of Object.entries(s.days)) {
      if (d < from) continue
      out[d] = (out[d] || 0) + b.tokens
    }
  }
  return out
}

/**
 * A handover brief for branching: what the chat was about and what it changed,
 * without the tool output that makes up most of its tokens. Meant for a fresh
 * session to read instead of replaying the whole history.
 */
function brief (id, { maxChars = 14000 } = {}) {
  const t = transcript(id)
  if (!t) return null
  const rec = index().find(s => s.id === id)
  const turns = full?.turns || []

  const trim = (v, n) => {
    const one = String(v || '').replace(/\s+/g, ' ').trim()
    return one.length > n ? one.slice(0, n).replace(/\s\S*$/, '') + '…' : one
  }

  // your asks are the spine of the story; Claude's replies give their opening only
  const beats = []
  for (const turn of turns) {
    if (!turn.text || turn.role === 'note') continue
    if (turn.role === 'user') {
      beats.push({ role: 'you', text: trim(turn.text, 700) })
    } else if (beats.length) {
      const first = turn.text.split(/\n\s*\n/).find(p => p.trim() && !/^```/.test(p.trim()))
      if (first) beats.push({ role: 'claude', text: trim(first, 420) })
    }
  }

  // keep the shape of it: how the chat opened, then where it actually got to
  const seen = new Set()
  const picked = [...beats.slice(0, 6), ...beats.slice(-40)].filter(b => {
    const k = b.role + b.text
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const files = (t.info?.files || []).slice(0, 14)
  const day = ts => new Date(ts).toISOString().slice(0, 10)
  const lines = ['# Handover brief · ' + (rec.title || id), '', '## What happened', '']
  let budget = maxChars - lines.join('\n').length
  for (const b of picked) {
    const line = b.role === 'you' ? `**Asked:** ${b.text}` : b.text
    if (budget - line.length < 600) { lines.push('*(middle of the conversation omitted)*', ''); break }
    lines.push(line, '')
    budget -= line.length + 2
  }
  if (files.length) {
    lines.push('## Files it changed', '')
    for (const f of files) lines.push(`- \`${f.path}\` (+${f.adds} -${f.dels})`)
    lines.push('')
  }
  return {
    text: lines.join('\n'),
    title: rec.title || id,
    cwd: rec.cwd,
    // what the new session needs in order to go and find more for itself
    provenance: {
      id, file: rec.file,
      title: rec.title || id,
      project: projectName(rec.cwd),
      cwd: rec.cwd,
      branch: (rec.branches || [])[0] || '',
      from: day(rec.firstTs), to: day(rec.lastTs),
      messages: rec.messages,
      files: (t.info?.files || []).map(f => f.path),
    },
  }
}

/**
 * Everything worth knowing about one chat. Read straight from the transcript, so
 * it covers what the summary cache does not: per-request usage, stop reasons,
 * thinking blocks, sub-agent work and how the context grew turn by turn.
 */
/**
 * The same page for a Codex rollout. Several panels stay empty because Codex
 * does not record what fills them - no stop reasons, no thinking budget, no
 * prompt-cache accounting beyond a cached-token count, and no cost, since it
 * bills against a plan. What it does record is filled in properly rather than
 * left at zero.
 */
function analyticsCodex (rec, raw) {
  const models = new Map(), tools = new Map()
  const growth = []
  let prompts = 0, replies = 0, requests = 0, compactions = 0
  let input = 0, output = 0, cacheRead = 0, peak = 0, window = 2e5
  let model = '', lastTotal = null, firstTs = 0, lastTs = 0

  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const p = e.payload || {}
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    if (ts) { if (!firstTs) firstTs = ts; lastTs = Math.max(lastTs, ts) }

    if (e.type === 'turn_context') { if (p.model) model = safeKey(String(p.model)); continue }
    if (e.type === 'compacted') { compactions++; continue }
    if (e.type === 'event_msg' && p.type === 'token_count') {
      const tot = p.info?.total_token_usage
      if (!tot) continue
      requests++
      const d = {
        input: Math.max(0, (tot.input_tokens || 0) - (lastTotal?.input_tokens || 0)),
        output: Math.max(0, (tot.output_tokens || 0) - (lastTotal?.output_tokens || 0)),
        cacheRead: Math.max(0, (tot.cached_input_tokens || 0) - (lastTotal?.cached_input_tokens || 0)),
      }
      lastTotal = tot
      input += d.input; output += d.output; cacheRead += d.cacheRead
      if (p.info?.model_context_window) window = p.info.model_context_window
      const ctx = p.info?.last_token_usage?.input_tokens || 0
      if (ctx) { peak = Math.max(peak, ctx); growth.push({ ts: e.timestamp || '', ctx }) }
      const m = (models.get(model || 'codex') || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tokens: 0 })
      m.requests++; m.input += d.input; m.output += d.output; m.cacheRead += d.cacheRead
      m.tokens += d.input + d.output + d.cacheRead
      models.set(model || 'codex', m)
      continue
    }
    if (e.type !== 'response_item') continue
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const n = p.name || p.type
      tools.set(n, (tools.get(n) || 0) + 1)
      continue
    }
    if (p.type !== 'message') continue
    if (p.role === 'user' && !CODEX_JUNK.test(clean(codexText(p)))) prompts++
    else if (p.role === 'assistant') replies++
  }

  const ctxOnly = growth.map(g => g.ctx)
  const jumps = ctxOnly.map((v, i) => (i ? v - ctxOnly[i - 1] : 0)).slice(1)
  const tokens = input + output + cacheRead
  const readable = input + cacheRead
  return {
    id: rec.id, title: rec.title, cwd: rec.cwd, project: projectName(rec.cwd),
    entrypoint: rec.entrypoint, firstTs, lastTs, provider: 'codex',
    messages: rec.messages, prompts, replies, requests,
    activeMs: rec.activeMs, durationMs: lastTs - firstTs,
    peak, window, pctWindow: window ? Math.round(peak / window * 100) : 0,
    tokens, input, output, cacheRead, cacheWrite: 0,
    cacheHit: readable ? cacheRead / readable : 0,
    cost: 0, cacheHour: 0, cacheFiveMin: 0, thinking: 0, thinkingTurns: 0,
    stops: {}, queued: 0, longestRun: 0,
    repliesPerAsk: prompts ? replies / prompts : 0,
    replyTokens: { shortest: 0, typical: 0, longest: 0 },
    growth, risePerRequest: jumps.length ? Math.round(jumps.reduce((a, b) => a + b, 0) / jumps.length) : 0,
    steepestRise: jumps.length ? Math.max(...jumps) : 0,
    steepestFall: jumps.length ? Math.min(...jumps) : 0,
    latest: ctxOnly.length ? ctxOnly[ctxOnly.length - 1] : 0,
    compactions,
    cold: { restarts: [], resent: 0, extra: 0, extraShare: 0, away: 0 },
    models: [...models.entries()].map(([mid, v]) => ({ id: mid, name: prettyModel(mid), ...v }))
      .sort((a, b) => b.tokens - a.tokens),
    tools: [...tools.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    agents: [],
    days: Object.entries(rec.days).map(([day, b]) => ({ day, ...b })).sort((a, b) => a.day < b.day ? -1 : 1),
    files: transcript(rec.id)?.info?.files || [],
  }
}

// Claude Code marks these models native_1m in its model catalog and runs them
// with a 1M window, writing their plain id with no [1m] suffix: Opus 4.7 and up,
// Sonnet 5 and up, Haiku 5.5, Fable, Mythos. Older ones (Opus 4.6, Sonnet 4.6,
// Haiku 4.5) are 200K unless the id carries [1m]. Take the last model seen,
// since /model can switch mid-chat. Past 200K it can only be 1M.
const ONE_M_DEFAULT = /^claude-(?:opus-(?:4-[7-9]|5)|sonnet-5|haiku-5-5|fable|mythos)/

function contextWindow (raw, peak) {
  if (peak > 2e5) return 1e6
  const ids = raw.match(/"modelId":"[^"]*"|"model":"claude-[^"]*"/g)
  if (!ids) return 2e5
  const id = ids[ids.length - 1].replace(/^"[a-zA-Z]+":"|"$/g, '')
  return /\[1m\]$/.test(id) || ONE_M_DEFAULT.test(id) ? 1e6 : 2e5
}

function analytics (id) {
  const rec = index().find(s => s.id === id)
  if (!rec) return null
  let raw; try { raw = fs.readFileSync(rec.file, 'utf8') } catch { return null }
  if (rec.provider === 'codex') return analyticsCodex(rec, raw)
  const seenIds = new Set()

  const models = new Map()        // per model: requests and token totals
  const tools = new Map()
  const agents = []               // sub-agent runs, from the sidechain records
  const stops = {}
  const growth = []               // context size at each assistant reply
  const outputs = []              // output tokens per reply, for the spread
  const turnGaps = []             // how long each of your turns took to answer
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, requests = 0
  let cacheHour = 0, cacheFiveMin = 0, thinking = 0, thinkingTurns = 0
  let prompts = 0, replies = 0, queued = 0
  let firstTs = 0, lastTs = 0, peak = 0
  let side = null, chain = 0, longestRun = 0
  let lastReq = 0
  const restarts = [], compactions = []

  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    if (ts) { if (!firstTs) firstTs = ts; lastTs = Math.max(lastTs, ts) }

    // a sub-agent's work is flagged, and bills to the session that spawned it
    if (e.isSidechain) {
      if (!side) side = { name: '', tools: 0, messages: 0, tokens: 0, cost: 0, from: ts, to: ts }
      side.messages++
      side.to = ts || side.to
      const u = e.message?.usage
      if (u) {
        const d = { input: u.input_tokens || 0, output: u.output_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }
        side.tokens += d.input + d.output + d.cacheWrite + d.cacheRead
        side.cost += costOf(e.message?.model || '', d)
      }
      for (const b of blocksOf(e)) if (b?.type === 'tool_use') side.tools++
      continue
    }
    if (side) { agents.push(side); side = null }

    if (e.type === 'user' && !e.isMeta) {
      prompts++
      chain = 0
      if (/^\s*\[Request interrupted/.test(textOf(e))) queued++
    }
    if (e.type !== 'assistant') continue

    replies++
    chain++
    longestRun = Math.max(longestRun, chain)
    const m = e.message || {}
    // a reply split across lines repeats its usage and stop reason on each one
    const repeat = !!(m.id && seenIds.has(m.id))
    if (m.id) seenIds.add(m.id)
    if (m.stop_reason && !repeat) stops[m.stop_reason] = (stops[m.stop_reason] || 0) + 1

    let hadThinking = false
    for (const b of blocksOf(e)) {
      if (b?.type === 'thinking') { thinking++; hadThinking = true }
      if (b?.type === 'tool_use') tools.set(b.name, (tools.get(b.name) || 0) + 1)
    }
    if (hadThinking) thinkingTurns++

    const u = !repeat && m.usage
    if (!u) continue
    requests++
    const d = { input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }
    input += d.input; output += d.output
    cacheRead += d.cacheRead; cacheWrite += d.cacheWrite
    cacheHour += u.cache_creation?.ephemeral_1h_input_tokens || 0
    cacheFiveMin += u.cache_creation?.ephemeral_5m_input_tokens || 0
    outputs.push(d.output)

    const ctx = d.input + d.cacheRead + d.cacheWrite
    if (ctx) {
      // After a long pause the stored conversation is gone: the next request
      // reads little from cache and writes most of the context out again. That
      // second write is the price of the pause.
      const away = lastReq ? ts - lastReq : 0
      const prev = growth.length ? growth[growth.length - 1].ctx : 0
      if (away > 40 * 6e4 && d.cacheWrite > 20000 && d.cacheRead < prev * 0.5 && prev) {
        const rate = rateFor(m.model || '').in
        restarts.push({
          at: ts, request: requests, away, context: prev,
          resent: d.cacheWrite,
          // written again at 1.25x the input rate, where reading it would have cost 0.1x
          extra: d.cacheWrite * (1.25 - 0.1) * rate / 1e6,
        })
      }
      if (growth.length && ctx < growth[growth.length - 1].ctx * 0.6) {
        compactions.push({ at: ts, request: requests, from: growth[growth.length - 1].ctx, to: ctx })
      }
      growth.push({ ctx, at: ts, request: requests })
      peak = Math.max(peak, ctx)
    }
    lastReq = ts

    const name = m.model || 'unknown'
    const acc = models.get(name) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    acc.requests++
    acc.input += d.input; acc.output += d.output
    acc.cacheRead += d.cacheRead; acc.cacheWrite += d.cacheWrite
    acc.cost += costOf(name, d)
    models.set(name, acc)
  }
  if (side) agents.push(side)

  const ctxOnly = growth.map(g => g.ctx)
  const sorted = [...outputs].sort((a, b) => a - b)
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const jumps = ctxOnly.map((v, i) => (i ? v - ctxOnly[i - 1] : 0)).slice(1)
  const rise = jumps.length ? Math.max(...jumps) : 0
  const fall = jumps.length ? Math.min(...jumps) : 0
  const extra = restarts.reduce((n, r) => n + r.extra, 0)
  const totalTokens = input + output + cacheRead + cacheWrite
  const readable = input + cacheRead + cacheWrite
  const window = contextWindow(raw, peak)

  return {
    id, title: rec.title, cwd: rec.cwd, project: projectName(rec.cwd),
    entrypoint: rec.entrypoint, firstTs, lastTs,
    messages: rec.messages, prompts, replies, requests,
    activeMs: rec.activeMs, durationMs: lastTs - firstTs,
    peak, window, pctWindow: window ? Math.round(peak / window * 100) : 0,
    tokens: totalTokens, input, output, cacheRead, cacheWrite,
    cacheHit: readable ? cacheRead / readable : 0,
    cost: rec.cost,
    cacheHour, cacheFiveMin, thinking, thinkingTurns,
    stops, queued, longestRun,
    repliesPerAsk: prompts ? replies / prompts : 0,
    replyTokens: { shortest: sorted[0] || 0, typical, longest: sorted[sorted.length - 1] || 0 },
    growth, risePerRequest: jumps.length ? Math.round(jumps.reduce((a, b) => a + b, 0) / jumps.length) : 0,
    steepestRise: rise, steepestFall: fall,
    latest: ctxOnly.length ? ctxOnly[ctxOnly.length - 1] : 0,
    compactions,
    cold: {
      restarts,
      resent: restarts.reduce((n, r) => n + r.resent, 0),
      extra, extraShare: rec.cost ? extra / rec.cost : 0,
      away: restarts.reduce((n, r) => n + r.away, 0),
    },
    models: [...models.entries()].filter(([k]) => !k.startsWith('<'))
      .map(([id, v]) => ({ id, name: prettyModel(id), ...v }))
      .sort((a, b) => b.cost - a.cost),
    tools: [...tools.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    // the in-file sidechain shape is gone: background agents now keep their own
    // transcripts, so the real list comes from there
    agents: agents.length ? agents.map(a => ({ ...a, ms: Math.max(0, a.to - a.from) }))
      : subAgents(id).map(a => ({ name: a.description, model: a.model, status: a.status,
        messages: a.messages, tools: a.tools, tokens: a.tokens, cost: a.cost,
        ms: Math.max(0, (a.endTs || 0) - (a.startTs || 0)) })),
    days: Object.entries(rec.days).map(([day, b]) => ({ day, ...b })).sort((a, b) => a.day < b.day ? -1 : 1),
    files: transcript(id)?.info?.files || [],
  }
}

/** One line saying what a tool call actually did, for the expanded view. */
function toolDetail (name, input = {}) {
  const short = p => String(p || '').split('/').slice(-2).join('/')
  const cut = (t, n = 120) => {
    const one = String(t || '').replace(/\s+/g, ' ').trim()
    return one.length > n ? one.slice(0, n) + '…' : one
  }
  switch (name) {
    // the whole command, not a preview - the reader wraps it in a code block
    case 'Bash': return String(input.command || '').trim()
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return short(input.file_path || input.notebook_path)
    case 'Grep': return cut(input.pattern, 60) + (input.path ? ` in ${short(input.path)}` : '')
    case 'Glob': return cut(input.pattern, 60)
    case 'WebFetch': return cut(input.url, 70)
    case 'WebSearch': return cut(input.query, 70)
    case 'Task': case 'Agent': return cut(input.description || input.prompt, 70)
    case 'SendMessage': return cut(input.summary || input.prompt || input.message, 70)
    case 'TodoWrite': return `${(input.todos || []).length} items`
    default: return cut(input.description || input.query || input.path || '', 60)
  }
}

/** The before/after text of one recorded edit, for the diff view. */
function editAt (id, ti, ei, part) {
  return turnsFor(id, part)?.[ti]?.edits?.[ei] || null
}

// ------------------------------------------------------------------ sub-agents
// A background agent keeps its own transcript beside the session's:
//   <project>/<sessionId>/subagents/agent-<agentId>.jsonl
// with a .meta.json naming it and recording who spawned it. Completion is not
// written there - it arrives back in the parent as a <task-notification>.

const agentDir = file => file.replace(/\.jsonl$/, '') + '/subagents'

/**
 * Agent files read once, then remembered until they change. A chat with 220
 * agents re-read 431 MB on every open - and on every hover, since a chat starts
 * loading when the pointer rests on it - which held up clicks for seconds.
 */
const AGENT_MEMO = new Map()      // file -> { stamp, signals, stats }
function agentFile (file) {
  let stamp = ''
  try { const s = fs.statSync(file); stamp = s.size + ':' + s.mtimeMs } catch { return null }
  const hit = AGENT_MEMO.get(file)
  if (hit && hit.stamp === stamp) return hit
  let raw; try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  const rec = { stamp, signals: agentSignals(file, raw), stats: agentStats(file, raw) }
  AGENT_MEMO.set(file, rec)
  return rec
}

/** Roll one agent's own transcript up into the numbers worth showing. */
function agentStats (file, raw) {
  const out = { messages: 0, tools: 0, tokens: 0, cost: 0, firstTs: 0, lastTs: 0, models: {} }
  const seenIds = new Set()
  if (raw === undefined) { try { raw = fs.readFileSync(file, 'utf8') } catch { return out } }
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    if (ts) { if (!out.firstTs) out.firstTs = ts; out.lastTs = Math.max(out.lastTs, ts) }
    // a reply split across lines repeats its usage on every line - count it once
    const mid = e.type === 'assistant' ? e.message?.id : null
    const repeat = !!(mid && seenIds.has(mid))
    if (mid) seenIds.add(mid)
    if (!e.isMeta && !repeat) out.messages++
    for (const b of blocksOf(e)) if (b?.type === 'tool_use') out.tools++
    const u = !repeat && e.message?.usage
    if (!u) continue
    const model = safeKey(e.message?.model || 'unknown')
    const d = {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
    }
    out.tokens += d.input + d.output + d.cacheWrite + d.cacheRead
    out.cost += costOf(model, d)
    out.models[model] = (out.models[model] || 0) + 1
  }
  return out
}

/** What the parent transcript knows: when each agent was launched, and how it ended. */
function agentSignals (file, raw) {
  const launch = {}, finish = {}
  if (raw === undefined) { try { raw = fs.readFileSync(file, 'utf8') } catch { return { launch, finish } } }
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    // the launch, with the prompt as it was actually sent
    const r = e.toolUseResult
    if (r && r.agentId) {
      launch[r.agentId] = {
        ts: e.timestamp ? Date.parse(e.timestamp) : 0,
        prompt: r.prompt || '', model: r.resolvedModel || '',
        description: r.description || '',
      }
    }
    // the finish. The same agent can be resumed and notify again, so the last wins.
    if (e.type === 'queue-operation' && e.operation === 'enqueue' && e.content) {
      const c = String(e.content)
      const id = /<task-id>([^<]+)<\/task-id>/.exec(c)
      if (!id) continue
      const status = /<status>([^<]+)<\/status>/.exec(c)
      const result = /<result>([\s\S]*?)<\/result>/.exec(c)
      finish[id[1]] = {
        ts: e.timestamp ? Date.parse(e.timestamp) : 0,
        status: status ? status[1] : 'completed',
        result: result ? result[1].trim() : '',
      }
    }
  }
  return { launch, finish }
}

/**
 * Every sub-agent a session spawned, nesting included. `parentAgentId` makes
 * this a tree rather than the flat list the transcript alone would give.
 */
function subAgents (id, signals) {
  const rec = index().find(s => s.id === id)
  if (!rec) return []
  const dir = agentDir(rec.file)
  let names; try { names = fs.readdirSync(dir) } catch { return [] }
  const metas = names.filter(n => n.endsWith('.meta.json'))
  if (!metas.length) return []
  // a nested agent is launched from inside another agent's transcript, so the
  // prompt and model for it are only found by reading those as well
  // the parent's own signals are passed in when the caller already has them
  const { launch, finish } = signals
    ? { launch: { ...signals.launch }, finish: { ...signals.finish } } : agentSignals(rec.file)
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const more = agentFile(path.join(dir, n))?.signals
    if (!more) continue
    Object.assign(launch, more.launch)
    for (const k of Object.keys(more.finish)) if (!finish[k]) finish[k] = more.finish[k]
  }
  const out = []
  for (const name of metas) {
    const aid = name.replace(/^agent-/, '').replace(/\.meta\.json$/, '')
    let meta = {}
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch {}
    const file = path.join(dir, `agent-${aid}.jsonl`)
    let mtime = 0
    try { mtime = fs.statSync(file).mtimeMs } catch {}
    const st = agentFile(file)?.stats || agentStats(file, '')
    const fin = finish[aid], lau = launch[aid] || {}
    // Nothing marks an agent as running. It is running if it never reported back
    // and its transcript is still being written to; anything older simply stopped.
    const status = fin ? (fin.status === 'completed' ? 'done' : fin.status)
      : (Date.now() - mtime < 18e4 ? 'running' : 'stopped')
    out.push({
      id: aid, sessionId: id,
      description: meta.description || lau.description || 'Agent',
      agentType: meta.agentType || '', model: meta.model || lau.model || '',
      parent: meta.parentAgentId || null, depth: meta.spawnDepth || 1,
      toolUseId: meta.toolUseId || '',
      status, prompt: lau.prompt || '', result: fin?.result || '',
      startTs: lau.ts || st.firstTs, endTs: fin?.ts || st.lastTs,
      messages: st.messages, tools: st.tools, tokens: st.tokens, cost: st.cost,
    })
  }
  return out.sort((a, b) => (a.startTs || 0) - (b.startTs || 0))
}

/** One sub-agent's own conversation, in the same shape a session renders in. */
function agentTranscript (id, agentId) {
  if (!/^[\w-]+$/.test(String(agentId))) return null
  const rec = index().find(s => s.id === id)
  if (!rec) return null
  const file = path.join(agentDir(rec.file), `agent-${agentId}.jsonl`)
  let raw; try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  const { turns, info } = parseTranscript(raw, true)
  const key = id + '#' + agentId
  full = { id: key, turns }
  const all = subAgents(id)
  const meta = all.find(a => a.id === agentId) || {}
  return {
    ...meta, id: key, agentId, sessionId: id, file,
    title: meta.description || 'Agent', cwd: rec.cwd,
    // the siblings travel with it, so the panel works from inside a thread too
    isAgent: true, agents: all, info, turns: slim(turns),
  }
}

/**
 * Messages Claude Code writes into the conversation itself, under the user's
 * name: a background agent reporting that it finished, or another Claude
 * session passing something on. They are recorded as user turns but were never
 * typed, so they are shown as a note, the way the terminal shows them, and do
 * not count as something you said.
 */
function harnessNote (e) {
  if (e.type !== 'user') return null
  const kind = e.origin && e.origin.kind
  const raw = textOf(e)
  if (kind === 'task-notification' || /^\s*<task-notification>/.test(raw)) {
    const tag = n => {
      const i = raw.indexOf(`<${n}>`); if (i < 0) return ''
      const j = raw.indexOf(`</${n}>`, i); return j < 0 ? '' : raw.slice(i + n.length + 2, j).trim()
    }
    const summary = tag('summary') || 'A background task finished'
    const status = tag('status')
    const ms = Number(tag('duration_ms')) || 0
    const took = ms ? (ms >= 6e4 ? `${Math.floor(ms / 6e4)}m ${Math.floor(ms % 6e4 / 1e3)}s` : `${Math.round(ms / 1e3)}s`) : ''
    const tools = tag('tool_uses')
    const bits = [took, tools ? `${tools} tool calls` : ''].filter(Boolean).join(' · ')
    const word = status && status !== 'completed' ? ` (${status})` : ''
    // Older notifications carry the agent's whole report; newer ones only say it
    // was handed back separately. Only a real report is kept.
    const result = tag('result')
    const report = result && !/report was delivered to you as a message/i.test(result) ? result : ''
    return { kind: 'agent', text: summary + word + (bits ? ` · ${bits}` : ''), detail: report }
  }
  if (kind === 'peer') {
    const body = raw.replace(/^Another Claude session sent a message:\s*/, '')
      .replace(/<agent-message[^>]*>/, '').replace(/<\/agent-message>\s*$/, '').trim()
    return { kind: 'peer', text: body }
  }
  return null
}

/** Drop the heavy bits: image bytes and edit bodies are fetched on demand. */
const slim = turns => turns.map((t, ti) => ({
  ...t,
  // a turn may carry neither: a screenshot read with nothing before it had no edits list
  images: (t.images || []).map((im, ii) => ({ ti, ii, path: im.path || null })),
  edits: (t.edits || []).map((ed, ei) => ({
    ti, ei, path: ed.path, tool: ed.tool, adds: ed.adds, dels: ed.dels,
  })),
}))

/**
 * One transcript file as renderable turns plus the footer numbers. A sub-agent
 * writes the same format as a session, so both go through here.
 */
function parseTranscript (raw, keepSidechain) {
  const st = parseStart(keepSidechain)
  parseMore(st, raw)
  return parseResult(st)
}

/**
 * The parse in three parts, so a chat already read can carry on from where it
 * stopped: only the lines Claude added since are read, not the whole file again.
 */
function parseStart (keepSidechain) {
  return {
    keepSidechain, turns: [], byFile: new Map(), cacheRead: 0, readable: 0, model: '',
    // the footer numbers: context used, cache efficiency, turns, and files touched
    info: { series: [], context: 0, window: 2e5, cachePct: 0, turns: 0, files: [] },
  }
}

function parseResult (st) {
  const info = { ...st.info }
  info.cachePct = st.readable ? Math.round(st.cacheRead / st.readable * 100) : 0
  const peak = Math.max(...info.series, 0)
  info.window = peak > 2e5 || /\[1m\]$/.test(st.model) || ONE_M_DEFAULT.test(st.model) ? 1e6 : 2e5
  info.files = [...st.byFile.values()].map(f => ({ ...f }))
    .sort((a, b) => (b.adds + b.dels) - (a.adds + a.dels))
  info.adds = info.files.reduce((n, f) => n + f.adds, 0)
  info.dels = info.files.reduce((n, f) => n + f.dels, 0)
  info.series = info.series.filter((_, i, a) => a.length < 160 || i % Math.ceil(a.length / 160) === 0)
  info.model = st.model                // the model the chat is on now, for the header
  return { turns: st.turns, info }
}

function parseMore (st, raw) {
  const { turns, info, byFile, keepSidechain } = st
  // the model last named decides the window, as contextWindow reads it
  const ids = raw.match(/"modelId":"[^"]*"|"model":"claude-[^"]*"/g)
  if (ids) st.model = ids[ids.length - 1].replace(/^"[a-zA-Z]+":"|"$/g, '')
  let { cacheRead, readable } = st
  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    // Claude writes its own markers into the transcript: a recap of what happened
    // while you were away, and a note wherever the conversation was compacted.
    if (e.type === 'system') {
      if (e.subtype === 'away_summary' && e.content) {
        turns.push({ role: 'note', kind: 'recap', text: clean(e.content),
          tools: [], images: [], edits: [], ts: e.timestamp || '' })
      } else if (e.subtype === 'compact_boundary') {
        const m = e.compactMetadata || {}
        turns.push({ role: 'note', kind: 'compact',
          text: m.preTokens ? `Conversation compacted · ${nfmt(m.preTokens)} tokens before` : 'Conversation compacted',
          tools: [], images: [], edits: [], ts: e.timestamp || '' })
      }
      continue
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue
    // a sub-agent's own file is entirely sidechain, so only a session filters them
    if (e.isSidechain && !keepSidechain) continue
    const note = harnessNote(e)
    if (note) {
      turns.push({ role: 'note', kind: note.kind, text: note.text, detail: note.detail || '',
        tools: [], images: [], edits: [], ts: e.timestamp || '' })
      continue
    }

    // A pasted screenshot arrives as its own meta record holding the file path, so
    // those are picked up and pinned onto the message they belong to.
    const shots = pastedImages(textOf(e))
    if (e.isMeta) {
      const prev = turns[turns.length - 1]
      if (shots.length && prev) {
        // The same screenshot arrives twice: inlined as base64 in the message the
        // model saw, and again here as a path. Keep the path version - it can open
        // the real file - and drop the inline copies it stands in for.
        for (let n = shots.length; n > 0 && prev.images.length; n--) {
          if (prev.images[prev.images.length - 1].path) break
          prev.images.pop()
        }
        prev.images.push(...shots)
      }
      else if (shots.length) turns.push({ role: 'user', text: '', tools: [], images: shots, edits: [], ts: e.timestamp || '' })
      continue
    }

    if (e.type === 'user') info.turns++
    const u = e.message?.usage
    if (u) {
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0)
      if (ctx) { info.series.push(ctx); info.context = ctx }
      cacheRead += u.cache_read_input_tokens || 0
      readable += ctx
    }
    for (const b of blocksOf(e)) {
      if (b?.type !== 'tool_use' || !EDITS.includes(b.name)) continue
      const file = b.input?.file_path || b.input?.notebook_path
      if (!file) continue
      const d = editDelta(b.name, b.input)
      const f = byFile.get(file) || { path: file, edits: 0, adds: 0, dels: 0, ts: e.timestamp || '' }
      f.edits++; f.adds += d.adds; f.dels += d.dels; f.ts = e.timestamp || f.ts
      byFile.set(file, f)
    }

    const text = textOf(e)
    const edits = blocksOf(e)
      .filter(b => b?.type === 'tool_use' && EDITS.includes(b.name) &&
        (b.input?.file_path || b.input?.notebook_path))
      .map(b => {
        const d = editDelta(b.name, b.input)
        return {
          path: b.input.file_path || b.input.notebook_path, tool: b.name,
          adds: d.adds, dels: d.dels,
          old: b.name === 'Edit' ? String(b.input.old_string || '') : '',
          new: b.name === 'Edit' ? String(b.input.new_string || '')
            : String(b.input.content ?? b.input.new_source ?? ''),
        }
      })
    const tools = blocksOf(e).filter(b => b?.type === 'tool_use')
      // an Agent call carries its tool_use id so the card can find the agent it spawned
      .map(b => b.name === 'Agent'
        ? { name: b.name, detail: toolDetail(b.name, b.input), useId: b.id }
        : { name: b.name, detail: toolDetail(b.name, b.input) })
    const images = blocksOf(e)
      .filter(b => b?.type === 'image' && b.source?.type === 'base64' && b.source.data)
      .map(b => ({ src: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` }))
      .concat(shots)
    if ((!text || JUNK.test(text)) && !tools.length && !images.length) continue
    turns.push({ role: e.type, text: JUNK.test(text) ? '' : text, tools, images, edits, ts: e.timestamp || '' })
  }
  st.cacheRead = cacheRead; st.readable = readable
}

/** The same turns, read out of a Codex rollout instead of a Claude transcript. */
function parseCodex (raw) {
  const turns = []
  const info = { series: [], context: 0, window: 2e5, cachePct: 0, turns: 0, files: [] }
  const byFile = new Map()
  const pending = new Map()      // patch call_id -> the turn that asked for it
  let cacheRead = 0, readable = 0, lastTotal = null

  for (const line of raw.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const p = e.payload || {}
    const ts = e.timestamp || ''

    if (e.type === 'session_meta') {
      if (p.model_context_window) info.window = p.model_context_window
      continue
    }
    if (e.type === 'turn_context' && p.model) { info.model = String(p.model); continue }
    if (e.type === 'compacted' || (e.type === 'event_msg' && p.type === 'context_compacted')) {
      if (e.type === 'compacted') {
        turns.push({ role: 'note', kind: 'compact', text: 'Conversation compacted',
          tools: [], images: [], edits: [], ts })
      }
      continue
    }
    if (e.type === 'event_msg' && p.type === 'token_count') {
      const tot = p.info?.total_token_usage
      if (!tot) continue
      const ctx = p.info?.last_token_usage?.input_tokens || 0
      if (ctx) { info.series.push(ctx); info.context = ctx }
      if (p.info?.model_context_window) info.window = p.info.model_context_window
      cacheRead += Math.max(0, (tot.cached_input_tokens || 0) - (lastTotal?.cached_input_tokens || 0))
      readable += Math.max(0, (tot.input_tokens || 0) - (lastTotal?.input_tokens || 0))
      lastTotal = tot
      continue
    }
    // the patch result carries the before/after, so the diff view works the
    // same as it does for a Claude edit
    if (e.type === 'event_msg' && p.type === 'patch_apply_end') {
      const into = pending.get(p.call_id) || turns[turns.length - 1]
      for (const [file, ch] of Object.entries(p.changes || {})) {
        const body = ch.content || ch.unified_diff || ''
        const d = ch.type === 'update'
          ? { adds: (body.match(/^\+/gm) || []).length, dels: (body.match(/^-/gm) || []).length }
          : ch.type === 'delete' ? { adds: 0, dels: lines(body) } : { adds: lines(body), dels: 0 }
        const f = byFile.get(file) || { path: file, edits: 0, adds: 0, dels: 0, ts }
        f.edits++; f.adds += d.adds; f.dels += d.dels; f.ts = ts || f.ts
        byFile.set(file, f)
        if (into) {
          into.edits.push({
            path: file, tool: ch.type === 'add' ? 'Write' : ch.type === 'delete' ? 'Delete' : 'Edit',
            adds: d.adds, dels: d.dels,
            // an update only records the diff, so there is no whole-file before
            old: ch.type === 'delete' ? body : '',
            new: ch.type === 'update' ? body : (ch.type === 'add' ? body : ''),
          })
        }
      }
      continue
    }
    if (e.type !== 'response_item') continue

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let detail = ''
      if (p.type === 'custom_tool_call') detail = String(p.input || '').split('\n')[0]
      else {
        try {
          const a = JSON.parse(p.arguments || '{}')
          detail = a.cmd || a.command || a.query || a.path || ''
        } catch { detail = '' }
      }
      const last = turns[turns.length - 1]
      const into = last && last.role === 'assistant' ? last
        : (turns.push({ role: 'assistant', text: '', tools: [], images: [], edits: [], ts }),
          turns[turns.length - 1])
      into.tools.push({ name: p.name || p.type, detail: String(detail).slice(0, 400) })
      if (p.call_id) pending.set(p.call_id, into)
      continue
    }
    if (p.type !== 'message') continue
    if (p.role !== 'user' && p.role !== 'assistant') continue

    const text = clean(codexText(p))
    if (p.role === 'user' && (CODEX_JUNK.test(text) || JUNK.test(text))) continue
    if (p.role === 'user') info.turns++
    const images = (p.content || [])
      .filter(c => c?.type === 'input_image' && c.image_url)
      .map(c => ({ src: c.image_url }))
    if (!text && !images.length) continue
    turns.push({ role: p.role, text, tools: [], images, edits: [], ts })
  }

  info.cachePct = readable ? Math.round(cacheRead / (cacheRead + readable) * 100) : 0
  info.files = [...byFile.values()].sort((a, b) => (b.adds + b.dels) - (a.adds + a.dels))
  info.adds = info.files.reduce((n, f) => n + f.adds, 0)
  info.dels = info.files.reduce((n, f) => n + f.dels, 0)
  info.series = info.series.filter((_, i, a) => a.length < 160 || i % Math.ceil(a.length / 160) === 0)
  return { turns, info }
}

/**
 * The running chats, each as its latest exchange: what you last asked and what
 * Claude last said. Only the end of each file is read - a board of ten chats
 * should not cost ten full transcripts.
 */
const TAIL_BYTES = 768 * 1024
// A step Claude takes at once: one still pending after a few seconds is
// waiting on you to allow it. Anything that can genuinely take a while - an
// agent, a web fetch, a tool from a server - is never read that way.
const INSTANT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep'])
const base = p => String(p || '').split('/').pop()

/** What a working chat is doing, read from the last step in its transcript. */
function nowDoing (raw, id, status) {
  const lines = raw.split('\n')
  let last = null
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
    if (!lines[i]) continue
    let e; try { e = JSON.parse(lines[i]) } catch { continue }
    if ((e.type === 'assistant' || e.type === 'user') && !e.isSidechain) { last = e; break }
  }
  if (!last || status !== 'busy') return {}
  const since = Date.parse(last.timestamp || '') || 0
  if (last.type === 'user') return { doing: 'Thinking', since }
  const tool = blocksOf(last).filter(b => b?.type === 'tool_use').pop()
  if (!tool) {
    // Claude has answered, but the turn stays open while background agents it
    // started are still running - say that, not "writing a reply"
    const { launch, finish } = agentSignals(null, raw)
    const running = Object.keys(launch).filter(k => !finish[k]).length
    return { doing: running ? `Waiting for ${running} ${running === 1 ? 'agent' : 'agents'}` : 'Writing a reply', since }
  }
  const inp = tool.input || {}
  const n = tool.name
  const doing = n === 'Edit' || n === 'MultiEdit' || n === 'Write' ? `Editing ${base(inp.file_path)}`
    : n === 'Read' ? `Reading ${base(inp.file_path)}`
      : n === 'Bash' ? `Running ${String(inp.description || inp.command || 'a command').split('\n')[0].slice(0, 60)}`
        : n === 'Grep' || n === 'Glob' ? 'Searching files'
          : n === 'WebFetch' || n === 'WebSearch' ? 'Searching the web'
            : n === 'Agent' || n === 'Task' ? `Running an agent: ${String(inp.description || '').slice(0, 50)}`
              : n === 'AskUserQuestion' ? 'Asking you a question'
                : n === 'ExitPlanMode' ? 'Showing you a plan'
                  : /^mcp__/.test(n) ? `Using ${n.split('__')[1] || 'a tool'}`
                    : `Using ${n}`
  const waitedMs = Date.now() - since
  let waiting = null
  if (n === 'AskUserQuestion' && waitedMs > 1500) waiting = 'question'
  else if (n === 'ExitPlanMode' && waitedMs > 1500) waiting = 'plan'
  else if (waitedMs > 6000 && (INSTANT.has(n) || (n === 'Bash' && !commandRunning(id)))) waiting = 'permission'
  return { doing, waiting, since }
}

/** Is a command Claude started still running under this chat? Commands run through a shell snapshot. */
function commandRunning (id) {
  const pid = LIVE_PIDS[id]
  if (!pid) return true                      // cannot tell: never claim it is waiting
  let out = ''
  try { out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 4000, maxBuffer: 1 << 24 }) } catch { return true }
  const rows = out.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
  const kids = new Map()
  for (const [, p, pp] of rows) { if (!kids.has(+pp)) kids.set(+pp, []); kids.get(+pp).push(+p) }
  const cmd = new Map(rows.map(r => [+r[1], r[3]]))
  const stack = [...(kids.get(pid) || [])]
  while (stack.length) {
    const p = stack.pop()
    if (/shell-snapshots/.test(cmd.get(p) || '')) return true
    stack.push(...(kids.get(p) || []))
  }
  return false
}

function board (live, folders) {
  const out = []
  // a chat belongs to this window when it ran in one of the window's folders
  // or anywhere beneath one; no folders means no filter
  const roots = (folders || []).map(f => f.replace(/\/+$/, ''))
  const mine = cwd => !roots.length || roots.some(r => cwd === r || (cwd || '').startsWith(r + '/'))
  for (const rec of index()) {
    const status = live[rec.id]
    if (!status || !mine(rec.cwd)) continue
    const codex = rec.provider === 'codex'
    let raw = ''
    try {
      const fd = fs.openSync(rec.file, 'r')
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      fs.closeSync(fd)
      raw = buf.toString('utf8')
      if (len < size) raw = raw.slice(raw.indexOf('\n') + 1)   // drop the cut first line
    } catch { continue }
    const { turns, info } = codex ? parseCodex(raw) : parseTranscript(raw)
    const now = codex ? {} : nowDoing(raw, rec.id, status)
    const said = [...turns].reverse().find(t => t.role === 'assistant' && t.text)
    const asked = [...turns].reverse().find(t => t.role === 'user' && t.text)
    out.push({
      id: rec.id, title: rec.title, project: rec.project || projectName(rec.cwd), status, provider: rec.provider || 'claude',
      cost: rec.cost, lastTs: rec.lastTs,
      context: info.context, window: info.window,
      reply: said ? said.text : '', replyTs: said ? Date.parse(said.ts) || 0 : 0,
      ask: asked ? asked.text : '', askTs: asked ? Date.parse(asked.ts) || 0 : 0,
      doing: now.doing || '', waiting: now.waiting || null,
    })
  }
  // the chat that last had a message on top, whichever side wrote it
  return out.sort((a, b) => b.lastTs - a.lastTs)
}

/**
 * Claude chats read before, kept parsed. Opening one again, or Claude writing
 * to it while it is on screen, reads only the lines added since - a 100 MB
 * chat was read from the start about once a second while Claude worked.
 */
const PARSED = new Map()          // id -> { file, off, st, signals }
const PARSED_MAX = 3

/** Whole lines from `off` to the end, and where the next read starts. */
function readFrom (file, off) {
  let size; try { size = fs.statSync(file).size } catch { return null }
  if (size < off) return null                   // rewritten, not appended: start over
  if (size === off) return { raw: '', off }
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - off)
    fs.readSync(fd, buf, 0, buf.length, off)
    const end = buf.lastIndexOf(10) + 1           // a line still being written waits
    return { raw: buf.subarray(0, end).toString('utf8'), off: off + end }
  } finally { fs.closeSync(fd) }
}

function transcript (id) {
  const rec = index().find(s => s.id === id)
  if (!rec) return null
  if (rec.provider === 'codex') {
    let raw; try { raw = fs.readFileSync(rec.file, 'utf8') } catch { return null }
    const { turns, info } = parseCodex(raw)
    full = { id, turns }
    return { ...rec, info, turns: slim(turns), agents: [] }
  }
  let c = PARSED.get(id)
  let more = c && c.file === rec.file ? readFrom(rec.file, c.off) : null
  if (!more) {
    c = { file: rec.file, off: 0, st: parseStart(), signals: { launch: {}, finish: {} } }
    more = readFrom(rec.file, 0)
    if (!more) return null
  }
  if (more.raw) {
    parseMore(c.st, more.raw)
    // the parent's agent launches and finishes, gathered the same way
    const sig = agentSignals(rec.file, more.raw)
    Object.assign(c.signals.launch, sig.launch)
    Object.assign(c.signals.finish, sig.finish)
  }
  c.off = more.off
  PARSED.delete(id); PARSED.set(id, c)            // newest last, oldest dropped first
  while (PARSED.size > PARSED_MAX) PARSED.delete(PARSED.keys().next().value)
  const { turns, info } = parseResult(c.st)
  full = { id, turns }
  // hand back the same shape minus the image bytes - those are fetched per image
  return { ...rec, info, turns: slim(turns), agents: subAgents(id, c.signals) }
}

/**
 * The end of a long chat only, for the first paint: the latest messages are
 * shown straight away and the rest follows. Most of a long chat's bytes are
 * tool output, so its last few megabytes hold far more messages than are first
 * drawn. A chat already read, or a short one, is simply read in full.
 */
const QUICK_BYTES = 6e6
let partCopy = null               // the partial copy's turns, for its images and diffs
function transcriptQuick (id) {
  const rec = index().find(s => s.id === id)
  if (!rec) return null
  let size = 0; try { size = fs.statSync(rec.file).size } catch { return null }
  if (rec.provider === 'codex' || PARSED.get(id)?.file === rec.file || size < QUICK_BYTES * 2) return transcript(id)
  const more = readFrom(rec.file, size - QUICK_BYTES)
  if (!more) return transcript(id)
  // the read starts mid-line: drop up to the first whole one
  const raw = more.raw.slice(more.raw.indexOf('\n') + 1)
  const st = parseStart()
  parseMore(st, raw)
  const { turns, info } = parseResult(st)
  partCopy = { id, turns }
  // agents come with the full read: a chat's agent files can be hundreds of megabytes
  return { ...rec, info, turns: slim(turns), agents: [], part: true }
}

// ------------------------------------------------------------------ pin / archive
// Our own flags, kept beside the cache so nothing is written into a transcript.
const STATE_FILE = path.join(HOME, '.claude', '.chistory-state.json')
const TRASH = path.join(HOME, '.claude', 'trashed-sessions')

function state () {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return s && typeof s === 'object' ? s : {}
  } catch { return {} }
}
const saveState = s => { try { writePrivate(STATE_FILE, JSON.stringify(s)) } catch {} }

/** Is this session pinned or archived right now? */
function isFlagged (id, key) {
  return (state()[key] || []).includes(id)
}

/**
 * Rename a chat.
 *
 * Claude reads a `custom-title` record appended to its own transcript, so a
 * rename made here shows up in its sidebar too - the one thing we write into a
 * transcript. A Codex rollout has no such record and no reader for one, so the
 * name is kept in our own state instead of pushed into a file Codex owns.
 */
function rename (id, title) {
  const rec = index().find(s => s.id === id)
  const name = String(title || '').trim()
  if (!rec || !name) return false
  if (rec.provider === 'codex') {
    const st = state()
    st.titles = st.titles || {}
    st.titles[id] = name
    saveState(st)
  } else {
    try {
      fs.appendFileSync(rec.file, JSON.stringify({
        type: 'custom-title', customTitle: name, sessionId: id,
      }) + '\n')
    } catch { return false }
  }
  index(true)
  return true
}

/** Toggle "pinned" / "archived" for one session. Returns the new value. */
function setFlag (id, key, on) {
  const s = state()
  const list = new Set(s[key] || [])
  const next = on === undefined ? !list.has(id) : !!on
  next ? list.add(id) : list.delete(id)
  s[key] = [...list]
  saveState(s)
  // Archiving keeps a copy: Claude Code prunes its own transcripts on a timer,
  // and an archived chat should outlive that.
  if (key === 'archived' && next) keepCopy(id)
  return next
}

const ARCHIVE = path.join(HOME, '.claude', 'chistory-archive')
function keepCopy (id) {
  if (!/^[\w-]+$/.test(String(id))) return false
  const rec = index().find(s => s.id === id)
  if (!rec) return false
  try {
    mkdirPrivate(ARCHIVE)
    const to = path.join(ARCHIVE, `${id}.jsonl`)
    fs.copyFileSync(rec.file, to)
    return true
  } catch { return false }
}

/** Move a transcript to ~/.claude/trashed-sessions - recoverable, never unlinked. */
function trash (id) {
  const rec = index().find(s => s.id === id)
  if (!rec) return false
  try {
    mkdirPrivate(TRASH)
    const name = `${Date.now()}-${path.basename(rec.file)}`
    fs.renameSync(rec.file, path.join(TRASH, name))
    setFlag(id, 'pinned', false)
    setFlag(id, 'archived', false)
    // where it came from, so Restore can put it back
    const st = state()
    st.trashed = { ...st.trashed, [name]: rec.file }
    saveState(st)
    index(true)
    return true
  } catch { return false }
}

/**
 * Where a deleted transcript lived. Recorded at delete time; for chats deleted
 * before that was kept, rebuilt the way each CLI names its files: Claude by the
 * launch folder with every non-alphanumeric turned into "-", Codex by the date
 * in the rollout's name.
 */
function trashOrigin (name, s) {
  const known = state().trashed?.[name]
  if (known) return known
  const base = name.replace(/^\d+-/, '')
  const d = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(base)
  if (d) return path.join(CODEX, d[1], d[2], d[3], base)
  if (s?.cwd) return path.join(PROJECTS, s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), base)
  // no folder in the file: the chat's sub-agent folder, left behind, still names it
  const id = base.slice(0, 36)
  try {
    const dir = fs.readdirSync(PROJECTS).find(d => fs.existsSync(path.join(PROJECTS, d, id)))
    if (dir) return path.join(PROJECTS, dir, base)
  } catch {}
  return ''
}

const TRASH_MEMO = new Map()           // trash file -> { mtime, s }
/** Deleted chats, newest deletion first. */
function trashedList () {
  let names = []
  try { names = fs.readdirSync(TRASH).filter(f => f.endsWith('.jsonl')) } catch { return [] }
  const out = []
  for (const name of names) {
    const file = path.join(TRASH, name)
    let mt; try { mt = fs.statSync(file).mtimeMs } catch { continue }
    let hit = TRASH_MEMO.get(file)
    if (!hit || hit.mtime !== mt) {
      const codex = /^\d+-rollout-/.test(name)
      hit = { mtime: mt, s: codex ? summariseCodex(file) : summarise(file) }
      TRASH_MEMO.set(file, hit)
    }
    const s = hit.s || {}
    if (!s.messages) continue          // an empty chat has nothing to bring back
    out.push({
      name, provider: s.provider || 'claude',
      title: (state().titles?.[s.id]) || s.title || 'Untitled chat',
      project: projectName(s.cwd), messages: s.messages || 0, lastTs: s.lastTs || 0,
      deletedAt: +name.split('-')[0] || mt, canRestore: !!trashOrigin(name, s),
    })
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Put a deleted chat back where it was. Never overwrites a file already there. */
function restore (name) {
  if (!/^\d+-[\w.-]+\.jsonl$/.test(String(name))) return { ok: false, err: 'Not a deleted chat.' }
  const file = path.join(TRASH, name)
  const hit = TRASH_MEMO.get(file)
  const to = trashOrigin(name, hit?.s || summarise(file) || summariseCodex(file))
  if (!to) return { ok: false, err: 'Could not tell which folder this chat came from.' }
  if (fs.existsSync(to)) return { ok: false, err: 'A chat with the same id is already there.' }
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(file, to)
  } catch (e) { return { ok: false, err: e.message } }
  TRASH_MEMO.delete(file)
  const st = state()
  if (st.trashed) { delete st.trashed[name]; saveState(st) }
  index(true)
  return { ok: true }
}

/** A folder like .../My Workspace/.cursor belongs to My Workspace, not ".cursor". */
function projectName (cwd) {
  if (!cwd) return '~'
  const base = path.basename(cwd)
  if (!base) return '~'
  if (base.startsWith('.')) return path.basename(path.dirname(cwd)) || base
  return base
}

/** Who branched from whom, in both directions. */
function branchMap () {
  const parents = {}, children = {}
  for (const s of index()) {
    // the record sits in the session that ran /branch: it names the new session
    // and, as the resume hint, the one it came from
    for (const kid of s.branchedTo || []) {
      const from = s.branchParent || s.id
      parents[kid] = from
      ;(children[from] ||= []).push(kid)
    }
  }
  return { parents, children }
}

function sessionList (live) {
  const g = groups()
  const b = branchMap()
  const st = state()
  const pin = new Set(st.pinned), arc = new Set(st.archived)
  return index().map(s => ({
    pinned: pin.has(s.id), archived: arc.has(s.id),
    branchedFrom: b.parents[s.id] || null,
    branches: b.children[s.id] || [],
    git: s.branches || [],                 // the git branch(es) the work happened on
    entrypoint: s.entrypoint || '',
    provider: s.provider || 'claude',
    id: s.id, title: s.title || '(untitled)',
    project: projectName(s.cwd), cwd: s.cwd,
    group: g[s.id]?.name || null, groupOrder: g[s.id]?.order ?? 999,
    // A transcript written seconds ago is working, whatever the last poll said -
    // the CLI check runs on a timer and can lag a reply by a few seconds.
    // A chat written to seconds ago counts as busy before Claude's own status
    // catches up - but only while its turn is still open. Once Claude has marked
    // the turn done it is idle straight away, rather than for another 15 seconds.
    live: (Date.now() - s.lastTs < 15000 && live[s.id] && s.turnOpen !== false)
      ? 'busy' : (live[s.id] || null),
    lastTs: s.lastTs, messages: s.messages, edits: s.edits,
    tokens: s.tokens, cost: s.cost, activeMs: s.activeMs,
  }))
}

function stats (days, offset = 0) {
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
  const cutoff = days ? day(days + offset - 1) : '0000-00-00'
  const today = day(offset)
  const out = { tokens: 0, cost: 0, messages: 0, edits: 0, activeMs: 0, sessions: 0,
    models: {}, byDay: {}, hours: {}, bySource: emptySplit() }
  const projects = new Set()
  const byProject = new Map()
  for (const s of index()) {
    let touched = false
    const src = out.bySource[sourceOf(s)]
    for (const [day, b] of Object.entries(s.days)) {
      if (day < cutoff || day > today) continue
      touched = true
      src.tokens += b.tokens; src.cost += b.cost; src.messages += b.messages
      out.tokens += b.tokens; out.cost += b.cost
      out.messages += b.messages; out.edits += b.edits
      out.activeMs += b.activeMs || 0
      for (const [h, n] of Object.entries(b.hours || {})) out.hours[h] = (out.hours[h] || 0) + n
      const d = (out.byDay[day] ||= { tokens: 0, cost: 0 })
      d.tokens += b.tokens; d.cost += b.cost
      for (const [m, v] of Object.entries(b.models)) {
        const a = (out.models[m] ||= { tokens: 0, cost: 0 })
        a.tokens += v.tokens; a.cost += v.cost
      }
    }
    if (touched) {
      out.sessions++
      src.sessions++
      if (s.cwd) projects.add(s.cwd)
      // per-project totals, so the digest can rank where the time went
      const name = projectName(s.cwd)
      const p = byProject.get(name) || { name, sessions: 0, tokens: 0, cost: 0 }
      p.sessions++
      for (const [day, b] of Object.entries(s.days)) {
        if (day < cutoff || day > today) continue
        p.tokens += b.tokens; p.cost += b.cost
      }
      byProject.set(name, p)
    }
  }
  return {
    ...out, projects: projects.size,
    top: [...byProject.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    models: Object.entries(out.models).filter(([, v]) => v.tokens > 0)
      .map(([id, v]) => ({ id, name: prettyModel(id), ...v }))
      .sort((a, b) => b.tokens - a.tokens),
  }
}

/** Consecutive active days: the run ending today or yesterday, and the best ever. */
function streaks () {
  const days = new Set()
  for (const s of index()) {
    for (const [day, b] of Object.entries(s.days)) if (b.messages) days.add(day)
  }
  const sorted = [...days].sort()
  let best = 0, run = 0, prev = null
  for (const d of sorted) {
    const step = prev && (Date.parse(d) - Date.parse(prev)) === 864e5
    run = step ? run + 1 : 1
    best = Math.max(best, run)
    prev = d
  }
  // the current run only counts if it reaches today or yesterday
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
  let current = 0
  for (let i = days.has(day(0)) ? 0 : 1; days.has(day(i)); i++) current++
  return { current, best, totalDays: days.size }
}

/** Tokens/cost per day over the last n days, independent of the selected range. */
function trend (n = 60, offset = 0) {
  const out = {}
  for (let i = n - 1 + offset; i >= offset; i--) {
    out[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] =
      { tokens: 0, cost: 0, messages: 0, edits: 0, in: 0, out: 0, cache: 0, sessions: 0 }
  }
  for (const s of index()) {
    for (const [day, b] of Object.entries(s.days)) {
      const t = out[day]
      if (!t) continue
      t.tokens += b.tokens; t.cost += b.cost
      t.messages += b.messages || 0; t.edits += b.edits || 0
      t.in += b.in || 0; t.out += b.out || 0; t.cache += b.cache || 0
      if (b.messages) t.sessions++
    }
  }
  return out
}

function toMarkdown (t) {
  const out = [`# ${t.title || t.id}`, '', `- Session: \`${t.id}\``, `- Folder: ${t.cwd}`,
    `- ${t.messages} messages · ${t.edits} file edits · $${t.cost.toFixed(2)} at API prices`, '', '---', '']
  for (const turn of t.turns) {
    out.push(`### ${turn.role === 'user' ? 'You' : 'Claude'}`, '')
    if (turn.text) out.push(turn.text, '')
    for (const tool of turn.tools) out.push(`> \`${tool.name}\``, '')
  }
  return out.join('\n')
}

// Files written before they were locked keep their old mode until rewritten.
for (const [f, mode] of [[CACHE_FILE, 0o600], [USAGE_FILE, 0o600], [SEARCH_FILE, 0o600], [STATE_FILE, 0o600],
  [ARCHIVE, 0o700], [TRASH, 0o700], [path.join(HOME, '.claude', 'chistory-briefs'), 0o700],
  [path.join(HOME, '.agent-logbook'), 0o700], [path.join(HOME, '.agent-logbook', 'activity.jsonl'), 0o600]]) {
  try { fs.chmodSync(f, mode) } catch {}
}
try {
  const dir = path.join(HOME, '.claude', 'chistory-briefs')
  for (const n of fs.readdirSync(dir)) try { fs.chmodSync(path.join(dir, n), 0o600) } catch {}
} catch {}

module.exports = {
  writePrivate, mkdirPrivate, board, setBin, index, rescan, search, warmSearch, liveSessionsAsync, resourcesAsync, sessionForPid, livePids, editAt, rename, agents: subAgents, agentTranscript, streaks, analytics, dashboard, branchMap, brief, isFlagged, livePid,
  groups, groupsFor, editGroups, projectName, refreshUsage, setFlag, trash, trashedList, restore, transcriptQuick, codexLiveAsync, imageAt, liveSessions, memories, transcript, sessionList, stats, trend, limits, toMarkdown, HOME }
