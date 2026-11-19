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

test('keeps emphasized final questions and handles Windows line endings', () => {
  for (const text of ['**Should I continue?**', '*Should I continue?*', '_Should I continue?_',
    'Summary.\r\n\r\nShould I continue?', '- Should I continue?']) {
    assert.deepEqual(find([block('assistant', text)]), [0])
  }
})

test('live changes add and remove question stops without retaining stale indices', () => {
  const cached = vm.createContext({ ALL_BLOCKS: [], QUESTIONS: [], questionBlocks: context.questionBlocks })
  vm.runInContext(section('function setQuestionBlocks (', '/** Only the end'), cached)
  for (const [blocks, expected] of [
    [[], []],
    [[block('assistant', 'Working')], []],
    [[block('assistant', 'Continue?')], [0]],
    [[block('user', 'Added earlier'), block('assistant', 'Continue?')], [1]],
    [[block('assistant', 'All complete.')], []]
  ]) {
    cached.setQuestionBlocks(blocks)
    assert.deepEqual(Array.from(cached.QUESTIONS), expected)
  }
})
test('groups consecutive assistant blocks and targets their final text', () => {
  assert.deepEqual(find([block('assistant', 'Ready?'), block('assistant', 'All done.')]), [])
  assert.deepEqual(find([block('assistant', 'Summary.'), block('assistant', 'Continue?'),
    block('assistant', '')]), [1])
})
test('ignores fenced code, quoted drafts and quoted questions', () => {
  for (const text of ['```js\nReady?\n```', '~~~\nReady?\n~~~', '> Ready?']) {
    assert.deepEqual(find([block('assistant', text)]), [])
  }
  assert.deepEqual(find([block('assistant', '> Draft question?\n\nShould I send it?')]), [0])
})

test('accepts the closing punctuation supported by claudeAsks', () => {
  for (const text of ['Continue?"', "Continue?'", '(Should I continue?)', '[Should I continue?]',
    '"Should I continue?"', '**(Should I continue?)**']) {
    assert.deepEqual(find([block('assistant', text)]), [0])
  }
  assert.deepEqual(find([block('assistant', '> "Could you extend the deadline?"')]), [])
})

test('keeps separate draft feedback questions but excludes recipient questions', () => {
  const draft = "Here's a draft you can send:\n\nDear Sir,\n\nCould you extend the deadline?"
  assert.deepEqual(find([block('assistant', draft)]), [])
  for (const followUp of ['Does this draft work for you?', 'Does this work for you?',
    'Would this tone suit you?', 'Is the draft ready to send?', 'Should I shorten it?']) {
    assert.deepEqual(find([block('assistant', draft + '\n\n' + followUp)]), [0])
  }
})

test('does not classify hyphenated draft descriptions as introductions', () => {
  for (const prefix of ["Here's a draft-related error:", 'Here is a draft-parser failure:',
    'Here is a draft-related error report.']) {
    assert.deepEqual(find([block('assistant', prefix + '\n\nWhat should I check?')]), [0])
  }
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
  for (const text of [
    'Here is the error message: timeout. What should I check?',
    'Here is the error message:\n\nTimeout.\n\nWhat should I check?',
    'Here is an existing message. What should happen next?',
    'Here is your message from yesterday:\n\nShould I investigate?'
  ]) assert.deepEqual(find([block('assistant', text)]), [0])
  for (const intro of ['Here is your draft:', "Here's a draft message:", 'Here is your email:',
    "Here's a draft you can send:", 'Here is a revised draft for your teacher:',
    "Here's a draft of the reply:", 'Here is a draft that you can adapt:']) {
    assert.deepEqual(find([block('assistant', intro + '\n\nCould you extend the deadline?')]), [])
    assert.deepEqual(find([block('assistant', intro + '\n\nCould you extend the deadline?\n\nWould you like me to shorten it?')]), [0])
  }
  assert.deepEqual(find([block('assistant', "Here's a draft. Would you like me to edit it?")]), [0])
  assert.deepEqual(find([block('assistant', "Here's a draft-related error. What should I check?")]), [0])
})

test('keeps the question source block when later blocks contain only excluded content', () => {
  for (const tail of ['```js\nconst value = 1\n```', '~~~\nHidden?\n~~~', '> Quoted question?', '   ']) {
    assert.deepEqual(find([block('assistant', 'Continue?'), block('assistant', tail)]), [0])
  }
  assert.deepEqual(find([block('assistant', 'Continue?\n\n```js'),
    block('assistant', 'Hidden?\n```')]), [0])
  assert.deepEqual(find([block('assistant', 'Continue?'), block('assistant', 'All done.')]), [])
  assert.deepEqual(find([block('assistant', 'Summary.'), block('assistant', 'Continue?'),
    block('assistant', '```\nHidden?\n```')]), [1])
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

test('locates the final prose question rather than questions in code or quotations', () => {
  const texts = [
    { textContent: 'First question?', parentElement: { closest: () => null } },
    { textContent: 'Final question?', parentElement: { closest: () => null } },
    { textContent: 'Code question?', parentElement: { closest: () => ({}) } }
  ]
  let chosen, start, end
  const positions = vm.createContext({ NodeFilter: { SHOW_TEXT: 4 }, document: {
    createTreeWalker: () => { let i = 0; return { nextNode: () => texts[i++] } },
    createRange: () => ({ setStart: (text, offset) => { chosen = text; start = offset },
      setEnd: (text, offset) => { end = offset }, getBoundingClientRect: () => ({ top: 450 }) })
  } })
  vm.runInContext(section('function questionTop (', 'function stepQuestion ('), positions)
  assert.equal(positions.questionTop({ querySelector: () => ({}) }), 450)
  assert.equal(chosen, texts[1])
  assert.equal(start, texts[1].textContent.indexOf('?'))
  assert.equal(end, start + 1)
})

test('navigation is harmless at boundaries and during an active jump', () => {
  const { nav, body, callbacks } = navigation({ 0: 100 })
  nav.stepQuestion(-1)
  nav.stepQuestion(1)
  assert.equal(body.scrollTop, 0)
  assert.equal(callbacks.length, 0)
  nav.QUESTION_JUMP = true
  nav.stepQuestion(1)
  assert.equal(callbacks.length, 0)
})

test('missing rendered question nodes do not throw or move the reader', () => {
  const { nav, body } = navigation({}, { questions: [0] })
  nav.stepQuestion(1)
  nav.stepQuestion(-1)
  assert.equal(body.scrollTop, 0)
  assert.equal(nav.QUESTION_JUMP, false)
})
