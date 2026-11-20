// Full-text search, run off the extension host's thread.
//
// Searching reads every transcript on disk - 626MB here, about 4.5 seconds -
// and it was doing that synchronously on the host. Nothing else could run
// meanwhile, so a chat clicked while the results were coming back did not open
// until the search finished, and Resume sat dead for the same few seconds. The
// work is the same; it just no longer holds the thread that handles clicks.
const { parentPort } = require('node:worker_threads')
const scan = require('./scan')
scan.readOnlyCache()          // the extension keeps the chat-list cache; this thread only reads it

// build the index while nothing is waiting on it, so the first search someone
// actually types is not the one that pays for it
// and the search index too - the first build reads every transcript once, which
// takes a few seconds, so it happens here in the background rather than on the
// first search someone types
try { scan.index(); scan.warmSearch() } catch {}

parentPort.on('message', msg => {
  if (!msg || msg.type !== 'search') return
  try {
    // rescan first: the host may have seen new transcripts since this started
    scan.index(!!msg.fresh)
    // each chat goes back as it is found, so the first one lands in a fraction
    // of the time the whole sweep takes
    const data = scan.search(msg.q, {
      limit: msg.limit,
      onChat: (chat, at) => parentPort.postMessage({ id: msg.id, chat, at }),
    })
    parentPort.postMessage({ id: msg.id, data })
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String(err && err.message || err) })
  }
})
