const { test } = require('node:test')
const assert = require('node:assert/strict')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { textOf, activityOf, summariseForTest } = require('../scan.js')
const msg = (...texts) => ({ entrypoint: 'sdk-cli', message: { role: 'user', content: texts.map(text => ({ type: 'text', text })) } })

test('shows the editor context and attachments sent beside a message as short chips', () => {
  const ctx = '<ide_selection>The user selected the lines 1 to 2 from /tmp/a.js:\nconst a = 1\n\nThis may or may not be related to the current task.</ide_selection>'
  const open = '<ide_opened_file>The user opened the file /tmp/a.js in the IDE. This may or may not be related to the current task.</ide_opened_file>'
  const file = '<attached-file name="notes.txt">\nline one\n</attached-file>'
  assert.equal(textOf(msg(ctx, open, file, 'Please check this')), '📄 a.js:1-2\n📄 a.js\n📎 notes.txt\nPlease check this')
})

test('an attachment ends at its own closing tag, not one inside the file', () => {
  const file = '<attached-file name="n.txt">\nsays </attached-file> inside\n</attached-file>'
  assert.equal(textOf(msg(file, 'hello')), '📎 n.txt\nhello')
})

test('keeps a message typed in exactly the shape of one of those blocks', () => {
  const typed = '<attached-file name="example.txt">\nhello\n</attached-file>'
  assert.equal(textOf(msg(typed)), typed)
  const ctx = '<ide_opened_file>The user opened the file /tmp/a.js in the IDE. This may or may not be related to the current task.</ide_opened_file>'
  assert.equal(textOf(msg(ctx)), ctx)
})

test('keeps a message that only starts like one of those blocks', () => {
  assert.equal(textOf(msg('<ide_selection> what does this tag do?')), '<ide_selection> what does this tag do?')
  assert.equal(textOf(msg('<attached-file name="x">\nnot really attached')), '<attached-file name="x">\nnot really attached')
  assert.equal(textOf(msg('quoting <ide_opened_file>x</ide_opened_file> here')), 'quoting <ide_opened_file>x</ide_opened_file> here')
})

test("leaves Claude's replies as written, marker-shaped or not", () => {
  const block = '<attached-file name="example.txt">\nhello\n</attached-file>'
  const reply = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: block }, { type: 'text', text: 'that is the format' }] } }
  assert.equal(textOf(reply), block + '\nthat is the format')
})

test("an agent's output shows its last step even when that step's result is huge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-agent-'))
  const file = path.join(dir, 'agent-test.jsonl')
  const L = o => JSON.stringify(o)
  fs.writeFileSync(file, [
    L({ type: 'user', message: { role: 'user', content: 'run the checks' } }),
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom\n' + 'x'.repeat(700 * 1024) }] } }),
  ].join('\n') + '\n')
  try {
    const out = activityOf(file)
    assert.match(out, /› Bash: npm test {2}\(failed\)/)
    assert.match(out, /boom/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("an agent's output keeps a recent failure whose call is far back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-agent-'))
  const file = path.join(dir, 'agent-test.jsonl')
  const L = o => JSON.stringify(o)
  // the call, then a long stretch of other records, then its failing result near the end
  const filler = Array.from({ length: 300 }, (_, k) => L({ type: 'user', isMeta: true, message: { role: 'user', content: 'note ' + k + ' ' + 'y'.repeat(4000) } }))
  fs.writeFileSync(file, [
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'make build' } }] } }),
    ...filler,
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'build broke' }] } }),
  ].join('\n') + '\n')
  try {
    const out = activityOf(file)
    assert.match(out, /› Bash: make build {2}\(failed\)/)
    assert.match(out, /build broke/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test("a whole agent file in another script is not marked as cut short", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-agent-'))
  const file = path.join(dir, 'agent-test.jsonl')
  const L = o => JSON.stringify(o)
  fs.writeFileSync(file, [
    L({ type: 'user', message: { role: 'user', content: 'Résumé der Änderungen 日本語' } }),
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fertig: 完了' }] } }),
  ].join('\n') + '\n')
  try {
    const out = activityOf(file)
    assert.doesNotMatch(out, /earlier steps left out/)
    assert.match(out, /完了/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an attachment-shaped block from another client is left as written', () => {
  const block = '<attached-file name="example.txt">\nhello\n</attached-file>'
  const other = { type: 'user', entrypoint: 'cli', message: { role: 'user', content: [{ type: 'text', text: block }, { type: 'text', text: 'see above' }] } }
  assert.equal(textOf(other), block + '\nsee above')
  const here = { ...other, entrypoint: 'sdk-cli' }
  assert.equal(textOf(here), '📎 example.txt\nsee above')
  const unknown = { type: 'user', message: other.message }
  assert.equal(textOf(unknown), block + '\nsee above')
})

test("an agent's output keeps a recent failure even with another step between it and its far-back call", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-agent-'))
  const file = path.join(dir, 'agent-test.jsonl')
  const L = o => JSON.stringify(o)
  const filler = n => Array.from({ length: n }, (_, k) => L({ type: 'user', isMeta: true, message: { role: 'user', content: 'note ' + k + ' ' + 'y'.repeat(4000) } }))
  fs.writeFileSync(file, [
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_far', name: 'Bash', input: { command: 'make build' } }] } }),
    ...filler(300),
    L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still waiting on the build' }] } }),
    ...filler(20),
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_far', is_error: true, content: 'build broke' }] } }),
  ].join('\n') + '\n')
  try {
    const out = activityOf(file)
    assert.match(out, /› Bash: make build {2}\(failed\)/)
    assert.match(out, /build broke/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a chat file with tool ids named like object properties does not break its summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-sum-'))
  const file = path.join(dir, 'chat.jsonl')
  const L = o => JSON.stringify(o)
  fs.writeFileSync(file, [
    L({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'go' } }),
    L({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/tmp/a.js', old_string: 'a', new_string: 'b' } }] } }),
    L({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'constructor', content: 'x' }, { type: 'tool_result', tool_use_id: '__proto__', content: 'y' }] } }),
  ].join('\n') + '\n')
  try {
    const s = summariseForTest(file)
    assert.ok(s && s.messages >= 1)
    assert.equal(s.edits, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
