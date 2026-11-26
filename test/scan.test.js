const { test } = require('node:test')
const assert = require('node:assert/strict')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { textOf, summariseForTest } = require('../scan.js')
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

test('an attachment-shaped block from another client is left as written', () => {
  const block = '<attached-file name="example.txt">\nhello\n</attached-file>'
  const other = { type: 'user', entrypoint: 'cli', message: { role: 'user', content: [{ type: 'text', text: block }, { type: 'text', text: 'see above' }] } }
  assert.equal(textOf(other), block + '\nsee above')
  const here = { ...other, entrypoint: 'sdk-cli' }
  assert.equal(textOf(here), '📎 example.txt\nsee above')
  const unknown = { type: 'user', message: other.message }
  assert.equal(textOf(unknown), block + '\nsee above')
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

test('a failed edit whose id is __proto__ still comes off the counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-sum-'))
  const file = path.join(dir, 'chat.jsonl')
  const L = o => JSON.stringify(o)
  fs.writeFileSync(file, [
    L({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'go' } }),
    L({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: '__proto__', name: 'Edit', input: { file_path: '/tmp/a.js', old_string: 'a', new_string: 'b' } }] } }),
    L({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: '__proto__', is_error: true, content: 'refused' }] } }),
  ].join('\n') + '\n')
  try {
    const s = summariseForTest(file)
    assert.equal(s.edits, 0)
    assert.deepEqual(Object.keys(s.files), [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a Codex chat is titled by the first message typed, not the instructions sent ahead of it', () => {
  const { summariseCodexForTest } = require('../scan.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'))
  try {
    const file = path.join(dir, 'rollout-2026-01-01T00-00-00-abc.jsonl')
    const user = text => ({ timestamp: '2026-01-01T00:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    fs.writeFileSync(file, [
      { type: 'session_meta', payload: { id: 'abc', cwd: '/tmp/example' } },
      user('# AGENTS.md instructions for /tmp/example\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>'),
      user('<environment_context>\n<cwd>/tmp/example</cwd>\n</environment_context>'),
      user('Rename the helper in utils'),
    ].map(l => JSON.stringify(l)).join('\n') + '\n')
    const s = summariseCodexForTest(file)
    assert.equal(s.title, 'Rename the helper in utils')
    assert.equal(s.turns, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
