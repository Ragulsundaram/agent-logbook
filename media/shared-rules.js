/**
 * Rules the extension and the chat view must agree on, kept in one place: which
 * files can go with a message and how big each kind may be, and which items the
 * line under the message box can show. Loaded by the webview as a script and by
 * extension.js with require, and kept free of the DOM so the tests can load it.
 */
;(function (root) {
  // text files Claude can read as they are, by extension. Not .env: it usually holds secrets
  const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'log', 'diff', 'patch',
    'toml', 'ini', 'conf']
  const PICTURES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
  // the host takes up to 25 MB of base64 per message, about 18.7 MB of PDF
  const LIMITS = { picture: 5 * 1024 * 1024, pdf: 18 * 1024 * 1024, text: 390 * 1024 }
  const LIMIT_WORDS = { picture: '5 MB', pdf: '18 MB', text: '390 KB' }

  /** The extension after the last dot of a file name, lower case: ".env" gives "env", "notes" gives "". */
  const extOf = name => ((/\.([\w]+)$/.exec(String(name || '')) || [])[1] || '').toLowerCase()
  /** picture, pdf, text, or '' for a file that cannot be attached. */
  function kindOf (name) {
    const ext = extOf(name)
    if (PICTURES[ext]) return 'picture'
    if (ext === 'pdf') return 'pdf'
    return TEXT_EXT.includes(ext) ? 'text' : ''
  }
  function mediaTypeOf (name) {
    const kind = kindOf(name)
    return kind === 'picture' ? PICTURES[extOf(name)] : kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain' : ''
  }

  // what the line under a chat's message box can show (claudeHistory.footerItems)
  const FOOTER_ITEMS = ['graph', 'context', 'cache', 'cost', 'replyTime', 'files']
  const FOOTER_DEFAULT = ['context', 'cost']
  /** A list of known items, each at most once. */
  const validFooterItems = v => Array.isArray(v) && v.every(x => FOOTER_ITEMS.includes(x)) && new Set(v).size === v.length

  const api = { TEXT_EXT, PICTURES, LIMITS, LIMIT_WORDS, extOf, kindOf, mediaTypeOf, FOOTER_ITEMS, FOOTER_DEFAULT, validFooterItems }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.sharedRules = api
})(typeof window !== 'undefined' ? window : globalThis)
