const { test } = require('node:test')
const assert = require('node:assert/strict')

globalThis.window = {}
require('../media/md.js')
const md = window.md
const nl = String.fromCharCode(10)
const fence = String.fromCharCode(96).repeat(3)

test('escapes HTML in text, lists, tables, headings, and quotes', () => {
  const payloads = [
    ['script', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['image', '<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;']
  ]
  const contexts = [
    ['text', value => value],
    ['list', value => '- ' + value],
    ['table', value => 'Name | Value' + nl + '--- | ---' + nl + value + ' | safe'],
    ['heading', value => '# ' + value],
    ['quote', value => '> ' + value]
  ]

  for (const [kind, payload, escaped] of payloads) {
    for (const [context, format] of contexts) {
      const html = md(format(payload))
      assert.ok(html.includes(escaped), kind + ' remains escaped in ' + context)
      assert.doesNotMatch(html, /<script/i, kind + ' is not emitted as a script tag')
      assert.doesNotMatch(html, /<img/i, kind + ' is not emitted as an image tag')
    }
  }
})

test('does not turn unsafe links or quotes into HTML attributes', () => {
  const javascriptLink = md('[click](javascript:alert(1))')
  assert.equal(javascriptLink, '<p>[click](javascript:alert(1))</p>')

  const brokenHref = md('[x](https://a.com"onmouseover="alert(1))')
  assert.equal(brokenHref, '<p><a href="https://a.com&quot;onmouseover=&quot;alert(1)" title="https://a.com&quot;onmouseover=&quot;alert(1)">x</a></p>')
})

test('escapes markup inside fenced code', () => {
  const html = md(fence + 'html' + nl + '</code></pre><script>' + nl + fence)
  assert.ok(html.includes('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;'))
  assert.doesNotMatch(html, /<script/i)
})

test('keeps ordinary Markdown working', () => {
  const html = md('**bold**' + nl + nl + '[link](https://example.com)' + nl + nl + fence + 'js' + nl + 'const x = 1' + nl + fence)
  assert.ok(html.includes('<strong>bold</strong>'))
  assert.ok(html.includes('<a href="https://example.com" title="https://example.com">link</a>'))
  assert.ok(html.includes('<pre class="code" data-lang="js"><code>const x = 1</code></pre>'))
})

test('keeps single line breaks inside a paragraph', () => {
  const html = md('Colour: blue' + nl + 'Size: **large**' + nl + nl + 'Next paragraph')
  assert.equal(html, '<p>Colour: blue<br>Size: <strong>large</strong></p><p>Next paragraph</p>')
})

test('a line break does not let bold run across lines', () => {
  const html = md('a **b' + nl + 'c** d')
  assert.doesNotMatch(html, /<strong>/)
})


test('keeps a balanced pair of parentheses in Markdown link destinations', () => {
  const html = md('[Mercury](https://example.com/wiki/Mercury_(planet))')
  assert.equal(html, '<p><a href="https://example.com/wiki/Mercury_(planet)" title="https://example.com/wiki/Mercury_(planet)">Mercury</a></p>')
})
