const { test } = require('node:test')
const assert = require('node:assert/strict')

globalThis.window = {}
require('../media/chat-moves.js')
const { PER_CHAT, readStart, readPlace, readDone, moveChatState } = window.chatMoves

function view () {
  const CHAT = Object.fromEntries(PER_CHAT.map(k => [k, new Map()]))
  CHAT.inflight = new Set()
  CHAT.sendWhenRead = new Set()
  return CHAT
}
const file = name => ({ name, mediaType: 'text/plain', text: 'hello' })

test('a read under way when /clear moves a chat lands on the new chat, with the waiting send', () => {
  const CHAT = view()
  const slot = readStart(CHAT, 'old')
  CHAT.sendWhenRead.add('old')
  moveChatState(CHAT, 'old', 'new')
  assert.equal(readPlace(CHAT, slot, 'files', file('notes.txt')), 'added')
  assert.deepEqual(CHAT.files.get('new').map(f => f.name), ['notes.txt'])
  assert.equal(CHAT.files.has('old'), false)
  assert.equal(readDone(CHAT, slot), true)               // the waiting Enter goes, from the new chat
  assert.equal(CHAT.reading.size, 0)
  assert.equal(CHAT.sendWhenRead.size, 0)
})

test('a ninth file finishing after the move is left out of the new chat', () => {
  const CHAT = view()
  CHAT.files.set('old', Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`)))
  const slot = readStart(CHAT, 'old')
  moveChatState(CHAT, 'old', 'new')
  assert.equal(readPlace(CHAT, slot, 'files', file('ninth.txt')), 'over')
  assert.equal(CHAT.files.get('new').length, 8)
  assert.equal(readDone(CHAT, slot), false)
})

test('reopening the earlier chat after the move: reads in both chats stay on their own chat', () => {
  const CHAT = view()
  moveChatState(CHAT, 'old', 'new')
  const later = readStart(CHAT, 'old')
  const fresh = readStart(CHAT, 'new')
  CHAT.sendWhenRead.add('old')
  assert.equal(readPlace(CHAT, later, 'files', file('a.txt')), 'added')
  assert.equal(readPlace(CHAT, fresh, 'pictures', { mediaType: 'image/png', data: 'x' }), 'added')
  assert.deepEqual(CHAT.files.get('old').map(f => f.name), ['a.txt'])
  assert.equal(CHAT.images.get('new').length, 1)
  assert.equal(readDone(CHAT, later), true)              // no count left behind: Enter is not held
  assert.equal(CHAT.reading.has('old'), false)
  assert.equal(CHAT.reading.get('new'), 1)
  assert.equal(readDone(CHAT, fresh), false)
  assert.equal(CHAT.reading.size, 0)
})

test('per-chat state moves to the new id', () => {
  const CHAT = view()
  CHAT.over.set('old', { pictures: [], files: ['ninth.txt'] })
  CHAT.drafts.set('old', 'half a thought')
  moveChatState(CHAT, 'old', 'new')
  assert.deepEqual(CHAT.over.get('new').files, ['ninth.txt'])
  assert.equal(CHAT.drafts.get('new'), 'half a thought')
  assert.equal(CHAT.over.has('old'), false)
})
