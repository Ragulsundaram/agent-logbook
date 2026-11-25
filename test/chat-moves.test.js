const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// the chat view's /clear bookkeeping, run on its own: the functions are taken
// from media/chat.js as written, with a bare CHAT state and no DOM
const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8')
function grab (name) {
  const i = src.indexOf(`function ${name} (`)
  assert.ok(i >= 0, `${name} not found`)
  for (let k = src.indexOf('{', i), d = 0; k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1)
  }
}
function view () {
  const keys = ['state', 'echo', 'partial', 'notes', 'picks', 'side', 'mcp', 'drafts', 'images', 'files', 'sentLog', 'shell', 'todosFold', 'over', 'mcpTop', 'reading']
  const CHAT = Object.fromEntries(keys.map(k => [k, new Map()]))
  CHAT.inflight = new Set()
  CHAT.sendWhenRead = new Set()
  const ctx = { CHAT, COMPOSER: null, sent: [] }
  ctx.submit = c => ctx.sent.push(c.id)
  vm.createContext(ctx)
  vm.runInContext(['readStart', 'readDone', 'moveChatState'].map(grab).join('\n'), ctx)
  return ctx
}

test('a read under way when /clear moves a chat finishes on the new chat, with the waiting send', () => {
  const v = view()
  const slot = v.readStart('old')
  v.CHAT.sendWhenRead.add('old')
  v.moveChatState('old', 'new')
  v.COMPOSER = { id: 'new' }
  assert.equal(slot.id, 'new')
  v.readDone(slot)
  assert.equal(v.CHAT.reading.size, 0)
  assert.deepEqual(v.sent, ['new'])
  assert.equal(v.CHAT.sendWhenRead.size, 0)
})

test('a read started in the earlier chat after the move stays there', () => {
  const v = view()
  v.moveChatState('old', 'new')
  const later = v.readStart('old')            // reopened the earlier chat and attached a file
  const fresh = v.readStart('new')            // and one in the new chat
  assert.equal(later.id, 'old')
  assert.equal(fresh.id, 'new')
  v.CHAT.sendWhenRead.add('old')
  v.COMPOSER = { id: 'old' }
  v.readDone(later)
  assert.equal(v.CHAT.reading.get('old'), undefined)  // no count left behind: Enter is not held
  assert.deepEqual(v.sent, ['old'])
  assert.equal(v.CHAT.reading.get('new'), 1)
  v.readDone(fresh)
  assert.equal(v.CHAT.reading.size, 0)
})

test('per-chat state moves to the new id', () => {
  const v = view()
  v.CHAT.files.set('old', [{ name: 'notes.txt' }])
  v.CHAT.over.set('old', { pictures: [], files: ['ninth.txt'] })
  v.moveChatState('old', 'new')
  assert.equal(v.CHAT.files.has('old'), false)
  assert.deepEqual(v.CHAT.over.get('new').files, ['ninth.txt'])
})
