// Opening a chat, run off the extension host's thread.
//
// A long chat is 100 MB or more, and reading one took from half a second to
// several - on the same thread that handles every click. A chat starts loading
// when the pointer rests on it, so moving across the list could hold the panel
// up for seconds and a click waited behind it (found in a recorded profile).
// Images and diffs come from here too: this thread keeps the chat it last read.
const { parentPort } = require('node:worker_threads')
const scan = require('./scan')
scan.readOnlyCache()          // the extension keeps the chat-list cache; this thread only reads it

// read the chat list once at start, so the first chat opened does not wait for it
try { scan.index() } catch {}

const CALLS = new Set(['transcript', 'transcriptQuick', 'agentTranscript', 'agentActivity', 'imageAt', 'editAt'])

parentPort.on('message', msg => {
  if (!msg || !CALLS.has(msg.fn)) return
  try {
    let data = scan[msg.fn](...msg.args)
    // a chat this thread has not seen yet: a new one started after its last look
    // (an agent with nothing written yet is not one: that is a normal answer, asked every 2s)
    if (data == null && !['imageAt', 'editAt', 'agentActivity'].includes(msg.fn)) {
      scan.index(true)
      data = scan[msg.fn](...msg.args)
    }
    parentPort.postMessage({ id: msg.id, data })
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String(err && err.message || err) })
  }
})
