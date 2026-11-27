const { test } = require('node:test')
const assert = require('node:assert/strict')

const rules = require('../media/shared-rules.js')

test('footer items: a list of known items, each once', () => {
  assert.equal(rules.validFooterItems(['context', 'cost']), true)
  assert.equal(rules.validFooterItems([]), true)
  assert.equal(rules.validFooterItems(rules.FOOTER_ITEMS), true)
  assert.equal(rules.validFooterItems(['context', 'context']), false)
  assert.equal(rules.validFooterItems(['context', 'colour']), false)
  assert.equal(rules.validFooterItems('context'), false)
  assert.equal(rules.validFooterItems(null), false)
  assert.equal(rules.validFooterItems({ 0: 'context', length: 1 }), false)
  assert.equal(rules.validFooterItems(rules.FOOTER_DEFAULT), true)
})

test('attachable kinds come from the file name, the same for a dotfile on both sides', () => {
  assert.equal(rules.kindOf('photo.JPG'), 'picture')
  assert.equal(rules.mediaTypeOf('photo.jpg'), 'image/jpeg')
  assert.equal(rules.kindOf('report.pdf'), 'pdf')
  assert.equal(rules.kindOf('notes.md'), 'text')
  assert.equal(rules.mediaTypeOf('notes.md'), 'text/plain')
  assert.equal(rules.kindOf('.env'), '')
  assert.equal(rules.kindOf('settings.env'), '')
  assert.equal(rules.kindOf('Makefile'), '')
  assert.equal(rules.kindOf('archive.zip'), '')
  assert.equal(rules.extOf('.env'), 'env')
  assert.equal(rules.extOf('notes'), '')
})

test('each kind has a size limit and words for it', () => {
  for (const k of ['picture', 'pdf', 'text']) {
    assert.ok(rules.LIMITS[k] > 0)
    assert.ok(rules.LIMIT_WORDS[k])
  }
})
