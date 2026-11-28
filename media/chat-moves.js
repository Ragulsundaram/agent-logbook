/**
 * The chat view's bookkeeping for pictures and files being read, and for /clear
 * moving a chat to a new id. Kept on its own, with no DOM, so the tests can
 * load it as the webview does.
 *
 * A read holds a slot that names its chat. /clear rewrites the slots under way
 * when it moves the chat, so only reads started before the move follow it; a
 * read started later in the earlier chat stays there.
 */
;(function (root) {
  // everything the view keeps per chat id that goes on under the new one
  const PER_CHAT = ['state', 'echo', 'partial', 'notes', 'picks', 'side', 'mcp', 'drafts', 'layout', 'images', 'files',
    'sentLog', 'shell', 'todosFold', 'over', 'mcpTop', 'reading', 'refused']

  function readStart (CHAT, id) {
    const slot = { id }
    CHAT.inflight.add(slot)
    CHAT.reading.set(id, (CHAT.reading.get(id) || 0) + 1)
    return slot
  }

  /**
   * A finished read's result goes to the chat its slot names now: added, or
   * reported as left out when that kind already holds 8. Returns which.
   */
  function readPlace (CHAT, slot, kind, item) {
    const map = kind === 'pictures' ? CHAT.images : CHAT.files
    const have = map.get(slot.id) || []
    if (have.length >= 8) return 'over'
    map.set(slot.id, [...have, item])
    return 'added'
  }

  /** One read is over. True when it was the chat's last and an Enter was waiting on it. */
  function readDone (CHAT, slot) {
    CHAT.inflight.delete(slot)
    const id = slot.id
    const left = (CHAT.reading.get(id) || 1) - 1
    if (left) CHAT.reading.set(id, left); else CHAT.reading.delete(id)
    return !left && CHAT.sendWhenRead.delete(id)
  }

  /** /clear: what the view holds for a chat goes on under its new id. */
  function moveChatState (CHAT, id, to) {
    for (const k of PER_CHAT) {
      if (CHAT[k].has(id)) { CHAT[k].set(to, CHAT[k].get(id)); CHAT[k].delete(id) }
    }
    // reads under way now, and an Enter waiting on them, follow; reads started later do not
    for (const slot of CHAT.inflight) if (slot.id === id) slot.id = to
    if (CHAT.sendWhenRead.delete(id)) CHAT.sendWhenRead.add(to)
  }

  root.chatMoves = { PER_CHAT, readStart, readPlace, readDone, moveChatState }
})(window)
