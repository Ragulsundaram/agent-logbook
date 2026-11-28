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

test('names that match a property every object has are not attachable', () => {
  for (const n of ['a.constructor', 'b.toString', 'c.hasOwnProperty', 'd.__proto__', 'e.valueOf']) {
    assert.equal(rules.kindOf(n), '', n)
    assert.equal(rules.mediaTypeOf(n), '', n)
  }
  assert.equal(rules.mediaTypeOf('photo.JPG'), 'image/jpeg')
  assert.equal(rules.mediaTypeOf('photo.Jpeg'), 'image/jpeg')
})

test('a file at the size limit still fits the base64 the extension takes when sending', () => {
  const b64 = n => 4 * Math.ceil(n / 3)
  assert.ok(b64(rules.LIMITS.pdf) < rules.PAYLOAD.pdfBase64)
  assert.ok(b64(rules.LIMITS.pdf + 3) >= rules.PAYLOAD.pdfBase64)
  assert.ok(b64(rules.LIMITS.picture) < rules.PAYLOAD.imageBase64)
  assert.ok(rules.LIMITS.text <= rules.PAYLOAD.textChars)
  assert.equal(rules.rawFor(rules.PAYLOAD.pdfBase64), rules.LIMITS.pdf)
  // the largest PDF the extension takes, and the next byte, which the box must refuse
  assert.equal(rules.LIMITS.pdf, 18749997)
  assert.ok(4 * Math.ceil(18749997 / 3) < rules.PAYLOAD.pdfBase64)
  assert.ok(4 * Math.ceil(18749998 / 3) >= rules.PAYLOAD.pdfBase64)
})

test('limit words never promise more than the limit', () => {
  assert.equal(rules.sizeWords(5 * 1024 * 1024), '5 MB')
  assert.equal(rules.sizeWords(390 * 1024), '390 KB')
  const mb = parseFloat(rules.LIMIT_WORDS.pdf)
  assert.ok(mb * 1024 * 1024 <= rules.LIMITS.pdf)
})

test('the same reason for a file wherever it comes from', () => {
  assert.equal(rules.refusal('.env'), 'may hold secrets')
  assert.equal(rules.refusal('prod.env'), 'may hold secrets')
  assert.equal(rules.refusal('tool.exe'), 'only pictures, PDFs and text files can be attached')
  assert.equal(rules.refusal('notes.md'), '')
})
