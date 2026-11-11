const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync('media/main.js', 'utf8')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const context = vm.createContext({})
vm.runInContext(section('function claudeAsks (', '/**\n * One-tap answers') + '\n' +
  section('function questionBlocks (', 'function refreshQuestions ('), context)
const block = (role, text) => ({ role, text })
const find = blocks => Array.from(context.questionBlocks(blocks))

test('finds only assistant reply endings', () => {
  assert.deepEqual(find([block('user', 'Ready?'), block('assistant', 'Shall I continue?'),
    block('user', 'Yes'), block('assistant', 'Why? Here is the explanation.')]), [1])
})
test('groups consecutive assistant blocks and targets their final text', () => {
  assert.deepEqual(find([block('assistant', 'Ready?'), block('assistant', 'All done.')]), [])
  assert.deepEqual(find([block('assistant', 'Summary.'), block('assistant', 'Continue?'),
    block('assistant', '')]), [1])
})
test('ignores fenced code, quoted drafts and quoted questions', () => {
  for (const text of ['```js\nReady?\n```', '~~~\nReady?\n~~~', '> Ready?', '"Ready?"']) {
    assert.deepEqual(find([block('assistant', text)]), [])
  }
  assert.deepEqual(find([block('assistant', '> Draft question?\n\nShould I send it?')]), [0])
})
test('finds questions before the initially rendered tail', () => {
  const blocks = [block('assistant', 'Continue?'), block('user', 'Yes')]
  for (let i = 0; i < 180; i++) blocks.push(block(i % 2 ? 'user' : 'assistant', 'Message.'))
  assert.deepEqual(find(blocks), [0])
})

test('ignores unquoted email questions and keeps a separate assistant follow-up', () => {
  const request = block('user', 'Write an email to my teacher asking for more time.')
  const draft = 'Dear Sir,\n\nCould you extend the deadline?'
  assert.deepEqual(find([request, block('assistant', draft)]), [])
  assert.deepEqual(find([block('assistant', "Here is your draft:\n\nCould you extend the deadline?")]), [])
  assert.deepEqual(find([request, block('assistant', draft + '\n\nWould you like me to shorten it?')]), [1])
  assert.deepEqual(find([request, block('assistant', draft), block('user', 'Explain the test.'),
    block('assistant', 'Should I run it?')]), [3])
})

test('previous loads an older target and stops following live output', () => {
  let loaded = 0, scrolled = false
  const first = { dataset: { bi: '160' }, getBoundingClientRect: () => ({ top: 100 }) }
  const body = { children: [first], getBoundingClientRect: () => ({ top: 100 }),
    querySelector: selector => {
      assert.equal(selector, '[data-bi="0"]')
      return { scrollIntoView: options => { scrolled = options.block === 'start' } }
    } }
  const nav = vm.createContext({ Date, $: () => body, questionBlocks: () => [0],
    ALL_BLOCKS: Array(181), SHOWN_FROM: 150, FOLLOW: true, AUTO_UNTIL: 0,
    drawEarlier: count => { loaded = count } })
  vm.runInContext(section('function stepQuestion (', '/** Step back'), nav)
  nav.stepQuestion(-1)
  assert.equal(loaded, 150)
  assert.equal(scrolled, true)
  assert.equal(nav.FOLLOW, false)
})
