const { test } = require('node:test')
const assert = require('node:assert/strict')

const { textOf } = require('../scan.js')
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

test('keeps a message that only starts like one of those blocks', () => {
  assert.equal(textOf(msg('<ide_selection> what does this tag do?')), '<ide_selection> what does this tag do?')
  assert.equal(textOf(msg('<attached-file name="x">\nnot really attached')), '<attached-file name="x">\nnot really attached')
  assert.equal(textOf(msg('quoting <ide_opened_file>x</ide_opened_file> here')), 'quoting <ide_opened_file>x</ide_opened_file> here')
})
