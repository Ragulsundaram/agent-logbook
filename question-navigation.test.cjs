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

test('keeps clarification questions after a drafting request', () => {
  assert.deepEqual(find([block('user', 'Write an email for me.'),
    block('assistant', 'What tone should I use?')]), [1])
})

test('does not mistake a message report for a draft introduction', () => {
  assert.deepEqual(find([block('assistant', "There's a new message. What should happen next?")]), [0])
  assert.deepEqual(find([block('assistant', 'There is a new message. Should I read it?')]), [0])
})

test('matches fence characters and lengths and resumes at genuine prose', () => {
  for (const text of ['````\n```\nHidden?', '```\n~~~\nHidden?', '```\n```not a closer\nHidden?']) {
    assert.deepEqual(find([block('assistant', text)]), [])
  }
  assert.deepEqual(find([block('assistant', '```js\nHidden?\n````\n\nShould I continue?')]), [0])
  assert.deepEqual(find([block('assistant', '~~~\nHidden?\n~~~\n\nContinue?')]), [0])
})

function navigation (positions, options = {}) {
  const callbacks = []
  let loaded = 0, feedback = ''
  const nodes = new Map(Object.entries(positions).map(([i, y]) => [Number(i), { y, isConnected: true }]))
  const body = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }),
    querySelector: selector => nodes.get(Number(/\d+/.exec(selector)[0])) }
  const label = { set textContent (value) { feedback = value } }
  const nav = vm.createContext({ Date, $: selector => selector === '.msgs' ? body : label,
    QUESTIONS: options.questions || [...nodes.keys()], QUESTION_JUMP: false,
    SHOWN_FROM: options.from || 0, FOLLOW: true, AUTO_UNTIL: 0,
    questionTop: node => node.y - body.scrollTop,
    refreshQuestions: () => { feedback = `${nav.QUESTIONS.length} questions` },
    requestAnimationFrame: fn => callbacks.push(fn),
    drawEarlier: count => { loaded = count; return options.fail !== true } })
  vm.runInContext(section('function stepQuestion (', '/** Step back'), nav)
  return { nav, body, callbacks, loaded: () => loaded, feedback: () => feedback }
}

test('previous loads an older target and corrects layout before releasing its guard', () => {
  const { nav, body, callbacks, loaded } = navigation({ 0: 50 }, { from: 150 })
  nav.stepQuestion(-1)
  assert.equal(loaded(), 150)
  assert.equal(body.scrollTop, -50)
  assert.equal(nav.FOLLOW, false)
  assert.equal(nav.QUESTION_JUMP, true)
  while (callbacks.length) callbacks.shift()()
  assert.equal(nav.QUESTION_JUMP, false)
})

test('next reaches a final reply question below the reader then advances to later questions', () => {
  const { nav, body, callbacks } = navigation({ 0: 600, 2: 900 })
  nav.stepQuestion(1)
  assert.equal(body.scrollTop, 500)
  while (callbacks.length) callbacks.shift()()
  nav.stepQuestion(1)
  assert.equal(body.scrollTop, 800)
})

test('failed older-message loading reports failure without moving the reader', () => {
  const { nav, body, feedback } = navigation({ 0: 50 }, { from: 150, fail: true })
  nav.stepQuestion(-1)
  assert.equal(body.scrollTop, 0)
  assert.equal(nav.QUESTION_JUMP, false)
  assert.equal(feedback(), 'Could not load this question')
  nav.QUESTIONS = []
  nav.stepQuestion(1)
  assert.equal(feedback(), '0 questions')
})

test('question cache is replaced when blocks are replaced', () => {
  const cached = vm.createContext({ ALL_BLOCKS: [], QUESTIONS: [], questionBlocks: context.questionBlocks })
  vm.runInContext(section('function setQuestionBlocks (', '/** Only the end'), cached)
  cached.setQuestionBlocks([block('assistant', 'Continue?')])
  assert.deepEqual(Array.from(cached.QUESTIONS), [0])
  cached.setQuestionBlocks([block('assistant', 'Complete.')])
  assert.deepEqual(Array.from(cached.QUESTIONS), [])
})
