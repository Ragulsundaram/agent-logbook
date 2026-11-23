const { test } = require('node:test')
const assert = require('node:assert/strict')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { textOf, activityOf } = require('../scan.js')
const msg = (...texts) => ({ message: { role: 'user', content: texts.map(text => ({ type: 'text', text })) } })

test('hides the editor context and attachments the logbook sends beside a message', () => {
  const ctx = '<ide_selection>The user selected the lines 1 to 2 from /tmp/a.js:\nconst a = 1\n\nThis may or may not be related to the current task.</ide_selection>'
  const open = '<ide_opened_file>The user opened the file /tmp/a.js in the IDE. This may or may not be related to the current task.</ide_opened_file>'
  const file = '<attached-file name="notes.txt">\nline one\n</attached-file>'
  assert.equal(textOf(msg(ctx, open, file, 'Please check this')), '📎 notes.txt\nPlease check this')
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
