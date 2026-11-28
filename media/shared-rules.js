/**
 * Rules the extension and the chat view must agree on, kept in one place: which
 * files can go with a message and how big each kind may be, and which items the
 * line under the message box can show. Loaded by the webview as a script and by
 * extension.js with require, and kept free of the DOM so the tests can load it.
 */
;(function (root) {
  // text files Claude can read as they are, by extension. Not .env: it usually holds secrets
  const TEXT_EXT = ('txt md csv tsv json yaml yml xml html css js ts jsx tsx py rb go rs java kt swift c h cpp cs php ' +
    'sh sql log diff patch toml ini conf').split(' ')
  const PICTURES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
  // the most base64 the extension takes per attachment when a message is sent (chatSend)
  const PAYLOAD = { pdfBase64: 25000000, imageBase64: 7000000, textChars: 400000 }
  // the largest file whose base64 stays under that cap: 4 characters for every 3 bytes, rounded up
  const rawFor = base64Max => 3 * Math.floor((base64Max - 1) / 4)
  const LIMITS = { picture: Math.min(5 * 1024 * 1024, rawFor(PAYLOAD.imageBase64)), pdf: rawFor(PAYLOAD.pdfBase64), text: 390 * 1024 }
  /** A limit in words, rounded down so it never promises more than it takes: "17.8 MB", "390 KB". */
  const sizeWords = n => n >= 1024 * 1024
    ? `${String(Math.floor(n / 1024 / 1024 * 10) / 10).replace(/\.0$/, '')} MB`
    : `${Math.floor(n / 1024)} KB`
  const LIMIT_WORDS = { picture: sizeWords(LIMITS.picture), pdf: sizeWords(LIMITS.pdf), text: sizeWords(LIMITS.text) }

  /** The extension after the last dot of a file name, lower case: ".env" gives "env", "notes" gives "". */
  const extOf = name => ((/\.([\w]+)$/.exec(String(name || '')) || [])[1] || '').toLowerCase()
  // own entries only: a name ending in ".constructor" is not a picture
  const pictureType = ext => Object.prototype.hasOwnProperty.call(PICTURES, ext) ? PICTURES[ext] : ''
  /** picture, pdf, text, or '' for a file that cannot be attached. */
  function kindOf (name) {
    const ext = extOf(name)
    if (pictureType(ext)) return 'picture'
    if (ext === 'pdf') return 'pdf'
    return TEXT_EXT.includes(ext) ? 'text' : ''
  }
  function mediaTypeOf (name) {
    const kind = kindOf(name)
    return kind === 'picture' ? pictureType(extOf(name)) : kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain' : ''
  }
  /** Why a file of this name cannot be attached, or '' when it can. */
  const refusal = name => extOf(name) === 'env' ? 'may hold secrets'
    : kindOf(name) ? '' : 'only pictures, PDFs and text files can be attached'

  // what the line under a chat's message box can show (claudeHistory.footerItems)
  const FOOTER_ITEMS = ['graph', 'context', 'cache', 'cost', 'replyTime', 'files']
  const FOOTER_DEFAULT = ['context', 'cost']
  /** A list of known items, each at most once. */
  const validFooterItems = v => Array.isArray(v) && v.every(x => FOOTER_ITEMS.includes(x)) && new Set(v).size === v.length

  const api = { TEXT_EXT, PICTURES, PAYLOAD, rawFor, LIMITS, LIMIT_WORDS, sizeWords, extOf, kindOf, mediaTypeOf, refusal,
    FOOTER_ITEMS, FOOTER_DEFAULT, validFooterItems }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.sharedRules = api
})(typeof window !== 'undefined' ? window : globalThis)
