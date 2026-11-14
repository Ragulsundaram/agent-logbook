const vs = acquireVsCodeApi()
const $ = s => document.querySelector(s)
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const send = m => vs.postMessage(m)

const nfmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n | 0)
const money = n => n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(2)
const niceDate = d => new Date(d + 'T12:00').toLocaleDateString(undefined,
  { day: 'numeric', month: 'short' })
const dur = ms => { const m = Math.round(ms / 6e4); return m < 60 ? m + 'm' : (m / 60).toFixed(m / 60 >= 10 ? 0 : 1) + 'h' }
const ago = ts => {
  const s = (Date.now() - ts) / 1000
  return s < 3600 ? Math.max(1, s / 60 | 0) + 'm' : s < 86400 ? (s / 3600 | 0) + 'h'
    : s < 6048e2 ? (s / 86400 | 0) + 'd' : (s / 6048e2 | 0) + 'w'
}
const clock = ts => {
  if (!ts) return ''
  const d = new Date(ts)
  if (DATEFMT === 'iso') {
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

let SESSIONS = [], MEM = [], days = 1
let TRASHED = []                                 // deleted chats, kept on disk until restored
let CUR = null, hits = [], hitAt = -1
let HERE = new Set()                           // the folders this window has open
const SHUT = new Set()                          // collapsed groups
const OPENED = new Set()                        // other folders' groups opened by hand
const SHOWN = new Map()                         // group -> how many rows are expanded
const ARCH = new Set()                          // groups showing their archived chats
let RESULTS = null, SEARCHING = ''              // matches from inside messages
let SEARCH_LIMIT = 60                           // chats asked for; Show more raises it
let streamPaint = 0                             // throttles the redraw while results stream in
const OPENHITS = new Set()                      // result cards left expanded
let RENAMING = null                             // a row being renamed right now
let ALLTOOLS = false                            // are all tool sections expanded?
let PAGE = 8
const MORE = 50
let SORT = 'recent', DATEFMT = 'locale', LIVE_FIRST = true
let FILTER = 'all'                              // 'all' | 'pinned' | 'deleted' | a group name
let GROUPS = []                                 // every group, including empty ones

/** Inline SVGs, so there is no icon font or asset to load. */
const ICONS = {
  shield: ['M12 3l7 3v5.5c0 4.4-3 8-7 9.5-4-1.5-7-5.1-7-9.5V6z', 'M9 12l2 2 4-4'],
  info: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17z', 'M12 11v5.2', 'M12 7.8v.1'],
  find: ['M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', 'M20 20l-4.8-4.8'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z'],
  scan: ['M4 6h16', 'M4 11h9', 'M4 16h6', 'M16.5 13.5a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z', 'M19 18.8l2 2'],
  diff: ['M6.5 3.5h8l4 4v13h-12z', 'M9.5 11.5h5', 'M12 9v5', 'M9.5 17h5'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z', 'M10 20.5a2 2 0 0 0 4 0'],
  pulse: ['M3 12h4l2.5-6 4 12 2.5-6H21'],
  sparkle: 'M12 1.5c.4 0 .73.3.79.7l.86 5.35 3.67-3.3a.8.8 0 1 1 1.11 1.11l-3.3 3.67 5.35.86a.8.8 0 0 1 0 1.58l-5.35.86 3.3 3.67a.8.8 0 1 1-1.11 1.11l-3.67-3.3-.86 5.35a.8.8 0 0 1-1.58 0l-.86-5.35-3.67 3.3a.8.8 0 0 1-1.11-1.11l3.3-3.67-5.35-.86a.8.8 0 0 1 0-1.58l5.35-.86-3.3-3.67a.8.8 0 0 1 1.11-1.11l3.67 3.3.86-5.35c.06-.4.39-.7.79-.7z',
  pin: 'M14.2 2.3a1 1 0 0 1 1.4 0l6.1 6.1a1 1 0 0 1-.7 1.7h-3l-3.6 3.6.5 3.3a1 1 0 0 1-1.7.9l-3.3-3.3-4.6 4.6a1 1 0 0 1-1.4-1.4l4.6-4.6-3.3-3.3a1 1 0 0 1 .9-1.7l3.3.5L13 5.1V2.9c0-.2.1-.4.2-.6z',
  play: 'M8 5.1c0-.8.9-1.3 1.5-.9l9 6.9c.6.4.6 1.4 0 1.8l-9 6.9c-.6.5-1.5 0-1.5-.8V5.1z',
  archive: 'M2 4.5h20v4H2v-4zm2 6h16V21H4V10.5zM9 13h6v2H9v-2z',
  trash: 'M9.5 2h5l.9 1.8H20v2H4v-2h4.6L9.5 2zM6 7.5h12l-1 13.5H7L6 7.5z',
  // drawn as outlines, so they read like the folder tree rather than solid blobs
  folder: 'M3.2 7.2a1.8 1.8 0 0 1 1.8-1.8h3.3l2 2.4h8.5a1.8 1.8 0 0 1 1.8 1.8v7.6a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8V7.2z',
  chevron: 'M9 5.5 15.5 12 9 18.5',
  terminal: ['M3 5.5h18v13H3z', 'M7 10l2.5 2.3L7 14.6', 'M12.5 15h4.5'],
  desktop: ['M3 5h18v11H3z', 'M9 20h6', 'M12 16v4'],
  vscode: ['M9.5 8 5 12l4.5 4', 'M14.5 8l4.5 4-4.5 4'],
  pencil: ['M4 20l1-4.5L16.2 4.3a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L8.5 19 4 20z'],
  split: ['M4 5h6v14H4z', 'M14 5h6v14h-6z'],
  open: ['M14 4h6v6', 'M20 4l-8.5 8.5', 'M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10'],
  copy: ['M9 9h9.5v11.5H9z', 'M15 6H5.5v11'],
  dots: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  message: ['M4 5.5h16v11H9l-5 4v-4H4z'],
  brief: ['M6 3.5h8.5L19 8v12.5H6z', 'M14 3.5V8h5', 'M9 12.5h7', 'M9 16h5'],
  card: ['M3 6h18v12H3z', 'M3 10h18'],
  calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8.5 3.5v3', 'M15.5 3.5v3'],
  book: ['M12 5.2a3.2 3.2 0 0 0-6 1.3 2.8 2.8 0 0 0-1.2 4.6A3 3 0 0 0 6 16.4a3 3 0 0 0 6 .6z',
    'M12 5.2a3.2 3.2 0 0 1 6 1.3 2.8 2.8 0 0 1 1.2 4.6A3 3 0 0 1 18 16.4a3 3 0 0 1-6 .6z',
    'M12 5.2V17'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  check: 'M5 12.5 10 17.5 19 7',
  list: ['M4 6.5h.01', 'M4 12h.01', 'M4 17.5h.01', 'M9 6.5h11', 'M9 12h11', 'M9 17.5h11'],
  // the expand-all / collapse-all glyph you supplied, on its own 16 grid
  expand: ['M9 9H4v1h5V9z', 'M7 12V7H6v5h1z',
    'M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z'],
  collapse: ['M9 9H4v1h5V9z',
    'M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z'],
  fork: ['M7 7v6a3 3 0 0 0 3 3h7', 'M7 4.6a2.4 2.4 0 1 0 0 .1', 'M17 13.6a2.4 2.4 0 1 0 0 .1', 'M7 19.4a2.4 2.4 0 1 0 0 .1'],
  chart: ['M4 20V11', 'M10 20V5', 'M16 20v-6', 'M2.5 20h19'],
  reload: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4.5h-4.5'],
  export: ['M12 15V4', 'M8.2 7.8 12 4l3.8 3.8', 'M4.5 14.5v4A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-4'],
  history: ['M3.6 12a8.4 8.4 0 1 0 2.6-6', 'M3.6 4.5V9H8', 'M12 7.6V12l3 1.9'],
  compact: ['M4 8.5 12 4l8 4.5', 'M4 15.5 12 20l8-4.5', 'M8.5 12h7'],
  layout: ['M4 5h16v14H4z', 'M14 5v14', 'M14 12h6'],
  gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
    'M19.3 14.5a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.13a1.8 1.8 0 1 1-3.6 0v-.07a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05a1.8 1.8 0 1 1-2.55-2.55l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9h-.13a1.8 1.8 0 1 1 0-3.6h.07a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05A1.8 1.8 0 1 1 7.66 3.1l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37v-.13a1.8 1.8 0 1 1 3.6 0v.07a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.13a1.8 1.8 0 1 1 0 3.6h-.07a1.5 1.5 0 0 0-1.37.9z'],
  agent: ['M7.5 8.5h9A2.5 2.5 0 0 1 19 11v5.5a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5V11a2.5 2.5 0 0 1 2.5-2.5z',
    'M12 5.5v3', 'M12 3.2a1.2 1.2 0 1 0 0 .1', 'M9.5 12.5v1.5', 'M14.5 12.5v1.5',
    'M2.5 12.5V15', 'M21.5 12.5V15'],
}
const OUTLINE = new Set(['shield', 'info', 'find', 'eye', 'scan', 'diff', 'bell', 'pulse', 'folder', 'chevron', 'terminal', 'desktop', 'vscode',
  'pencil', 'split', 'open', 'copy', 'fork', 'chart', 'reload', 'export',
  'history', 'compact', 'dots', 'message', 'card', 'calendar', 'book', 'plus', 'list', 'brief',
  'agent', 'gear', 'layout', 'close', 'check'])

// where Resume goes, remembered by the host between windows
const TARGETS = {
  auto: { icon: 'sparkle', label: 'Where it started', hint: 'follows the chat' },
  terminal: { icon: 'terminal', label: 'Terminal', hint: 'inside Cursor' },
  claude: { icon: 'vscode', label: 'Claude Code extension', hint: 'this editor' },
  desktop: { icon: 'desktop', label: 'Claude Desktop', hint: 'app' },
}
let TARGET = 'auto'

// a couple of icons are drawn on a 16 grid rather than 24
const GRID16 = new Set(['expand', 'collapse'])

function icon (name, cls) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', GRID16.has(name) ? '0 0 16 16' : '0 0 24 24')
  svg.setAttribute('class', (cls || name + '-ico') + (OUTLINE.has(name) ? ' outline' : ''))
  for (const d of [].concat(ICONS[name])) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}
const sparkle = () => icon('sparkle', 'spark-ico')

// Codex's own mark, which needs a gradient and a clip path and so cannot come
// from the flat path registry the rest of the icons use.
let CODEX_N = 0
const CODEX_SVG = `<svg viewBox="0 0 384 385" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="55.9321" y="117.024" width="256.063" height="170.124" fill="white"/><path d="M129.361 7.34581C144.776 1.00365 161.558 -1.28773 178.108 0.689774C199.442 3.14312 218.45 12.2098 235.133 27.8899C235.346 28.1032 235.645 28.2526 235.922 28.3379C236.224 28.4018 236.537 28.4018 236.839 28.3379C258.529 22.7477 281.483 24.8201 301.821 34.2046L302.824 34.6739L305.298 35.89C326.579 46.6848 343.18 64.8867 351.976 87.0689C356.434 97.9489 358.653 109.277 358.696 121.096C359.016 129.885 358.056 138.674 355.837 147.187C355.73 147.616 355.732 148.066 355.844 148.495C355.956 148.924 356.174 149.317 356.477 149.64C369.149 162.589 377.555 178.013 381.715 195.933C387.88 226.334 381.565 253.747 362.792 278.153L359.89 281.694C347.457 295.927 331.137 306.218 312.936 311.305C312.538 311.416 312.174 311.621 311.873 311.903C311.572 312.186 311.344 312.536 311.208 312.926C307.133 324.681 303.037 334.75 295.421 344.798C276.221 370.121 248.018 384.18 216.252 384.009C190.93 383.881 168.487 374.622 148.903 356.233C148.606 355.961 148.243 355.771 147.85 355.681C147.458 355.591 147.048 355.605 146.663 355.721C138.385 358.388 130.023 358.772 120.977 358.665C106.57 358.552 92.3783 355.151 79.4837 348.724C65.9799 342.024 54.2207 332.273 45.1369 320.243C41.8942 315.934 38.6729 311.881 36.3049 307.081C33.0708 300.495 30.4292 293.634 28.4115 286.579C24.1425 270.529 24.0397 253.656 28.1128 237.555C28.2403 237.17 28.2839 236.763 28.2408 236.36C28.171 235.963 27.9678 235.602 27.6648 235.336C17.8102 225.362 10.2782 213.335 5.60605 200.115C2.49953 191.971 0.692577 183.39 0.25136 174.685C-0.522274 163.22 0.492535 151.705 3.25938 140.552C10.4487 116.829 24.2088 98.2049 44.4969 84.7009C49.0196 81.6928 53.3076 79.3462 57.3183 77.6608C61.8208 75.7976 66.4214 74.1809 71.0997 72.8181C71.4273 72.7127 71.7244 72.5296 71.9659 72.2844C72.2074 72.0392 72.3859 71.7393 72.4864 71.4101C75.9865 58.8461 82.0034 47.1244 90.1718 36.9566C100.474 23.8829 113.971 13.6846 129.361 7.34581ZM203.644 232.734C200.184 232.945 196.934 234.464 194.553 236.984C192.172 239.504 190.838 242.835 190.823 246.302C190.838 249.768 192.172 253.099 194.553 255.619C196.934 258.139 200.184 259.659 203.644 259.87H281.213L281.981 259.891C285.58 259.874 289.026 258.437 291.571 255.892C294.116 253.347 295.553 249.901 295.57 246.302C295.553 242.703 294.116 239.256 291.571 236.711C289.026 234.166 285.58 232.729 281.981 232.712L281.213 232.734H203.644ZM116.519 132.914C115.299 130.937 113.595 129.304 111.568 128.169C109.541 127.034 107.258 126.435 104.935 126.429C102.598 126.447 100.306 127.064 98.2765 128.222C96.2471 129.379 94.5486 131.038 93.3434 133.039C92.1383 135.04 91.4669 137.318 91.3934 139.653C91.32 141.988 91.8469 144.303 92.9238 146.376L120.06 193.821L93.0518 239.39C91.5066 242.469 91.1866 246.019 92.1564 249.325C93.1261 252.631 95.3134 255.446 98.2771 257.203C101.241 258.959 104.76 259.527 108.126 258.79C111.491 258.054 114.453 256.069 116.412 253.235L147.431 200.861C148.652 198.797 149.305 196.447 149.323 194.049C149.342 191.651 148.726 189.291 147.537 187.208L116.519 132.914Z" fill="url(#chx-codex-grad)"/><defs><linearGradient id="chx-codex-grad" x1="191.996" y1="0.00710387" x2="191.996" y2="384.009" gradientUnits="userSpaceOnUse"><stop stop-color="#B1A7FF"/><stop offset="0.5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>`

const svgFrom = markup => {
  const t = document.createElement('template')
  t.innerHTML = markup.trim()
  return t.content.firstElementChild
}

// which CLI a chat came from, said with the mark rather than a word - the row
// already carries a title and a time
const SOURCES = {
  claude: { label: 'Claude Code', draw: () => icon('sparkle', 'spark-ico') },
  // each copy gets its own gradient id: with one shared id, a copy on a hidden
  // page held the only definition and every other copy drew without colour
  codex: { label: 'Codex', draw: () => svgFrom(CODEX_SVG.replace(/chx-codex-grad/g, `chx-codex-grad-${++CODEX_N}`)) },
}
const sourceIcon = provider => {
  const key = SOURCES[provider] ? provider : 'claude'
  const g = SOURCES[key].draw()
  g.setAttribute('class', key === 'codex' ? 'codex-ico' : 'spark-ico')
  const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title')
  tip.textContent = SOURCES[key].label
  g.appendChild(tip)
  return g
}

// ---------------------------------------------------------------- tabs
// Native titles take about a second to appear and often never do inside a webview.
// This shows the same text immediately, anchored under the button.
const TIP = el('div', 'tip')
TIP.hidden = true
document.body.appendChild(TIP)
function tips (root = document) {
  for (const n of root.querySelectorAll('[title]')) {
    if (n.dataset.tip) continue
    n.dataset.tip = n.title
    n.removeAttribute('title')
    n.addEventListener('mouseenter', () => {
      TIP.textContent = n.dataset.tip
      TIP.hidden = false
      const b = n.getBoundingClientRect(), t = TIP.getBoundingClientRect()
      TIP.style.left = `${Math.max(6, Math.min(b.left + b.width / 2 - t.width / 2,
        window.innerWidth - t.width - 6))}px`
      TIP.style.top = `${Math.min(b.bottom + 6, window.innerHeight - t.height - 6)}px`
    })
    n.addEventListener('mouseleave', () => { TIP.hidden = true })
    n.addEventListener('click', () => { TIP.hidden = true })
  }
}

// Links and file paths inside rendered messages. A URL opens in the browser; a
// path shows in Finder, or opens in the editor with Cmd/Ctrl held. A relative
// path is read against the folder of the chat it was written in.
document.addEventListener('click', e => {
  const p = e.target.closest?.('.pathlink')
  if (p) {
    e.preventDefault()
    const id = p.closest('[data-id]')?.dataset.id
    const cwd = SESSIONS.find(s => s.id === id)?.cwd || CUR?.cwd || ''
    send({ type: 'openPath', path: p.dataset.path, cwd, edit: e.metaKey || e.ctrlKey })
    return
  }
  const a = e.target.closest?.('a[href^="http"]')
  if (a) { e.preventDefault(); send({ type: 'openUrl', url: a.href }) }
})

// The webview's own right-click menu only offers Copy over a selection, so
// right-clicking a link or a message gave a greyed-out Copy. Inside a message,
// offer what can actually be copied from where you clicked.
document.addEventListener('contextmenu', e => {
  if (e.defaultPrevented || e.target.closest?.('input, textarea, .ctx')) return
  const bubble = e.target.closest?.('.bubble')
  const a = e.target.closest?.('a[href^="http"]')
  const p = e.target.closest?.('.pathlink')
  if (!bubble && !a && !p) return
  e.preventDefault()
  document.querySelector('.ctx')?.remove()

  const sel = document.getSelection()
  const range = sel && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null
  const pre = e.target.closest?.('pre')
  const src = bubble?.dataset.src

  const menu = el('div', 'ctx')
  // keep the selection alive while the pointer goes down on an item
  menu.onmousedown = ev => ev.preventDefault()
  const item = (label, fn) => {
    const b = el('button', 'ctxitem')
    b.append(icon('copy', 'cico outline'), el('span', '', label))
    b.onclick = ev => { ev.stopPropagation(); kill(); fn() }
    menu.appendChild(b)
  }
  if (range) {
    item('Copy', () => {
      sel.removeAllRanges(); sel.addRange(range)
      if (!document.execCommand('copy')) send({ type: 'copy', text: String(sel), label: 'Copied' })
    })
  }
  if (a) item('Copy link', () => send({ type: 'copy', text: a.href, label: 'Link copied' }))
  if (p) item('Copy path', () => send({ type: 'copy', text: p.dataset.path, label: 'Path copied' }))
  if (pre) item('Copy code', () => send({ type: 'copy', text: pre.textContent, label: 'Code copied' }))
  if (src) {
    item('Copy message', () => {
      if (!copyRich(src, flatHtml(window.md(src)))) send({ type: 'copy', text: src, label: 'Message copied' })
    })
  }
  if (!menu.childElementCount) return

  document.body.appendChild(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - box.height - 8)}px`
  const kill = dismissOn(menu)
})

const TABICON = { chats: 'message', usage: 'card', digest: 'calendar', memory: 'book', agents: 'agent', settings: 'gear' }
const TABNAME = { chats: 'Chats', usage: 'Card', digest: 'Digest', memory: 'Memory', agents: 'Agents', settings: 'Settings' }
let TAB = 'chats'

document.querySelectorAll('.tab').forEach(b => {
  b.append(icon(TABICON[b.dataset.tab]), el('span', 'tlabel', TABNAME[b.dataset.tab]))
  b.onclick = () => {
    TAB = b.dataset.tab
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b))
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + TAB))
    $('#rescan').hidden = TAB !== 'chats'
    // back on chats with a chat still open: that chat is the screen, as before
    $('#tabs').hidden = TAB === 'chats' && !$('#detail').hidden
    if (TAB === 'chats' && $('#detail').hidden) renderList()
    if (TAB === 'usage') send({ type: 'stats', days })
    if (TAB === 'digest') askDigest()
    if (TAB === 'memory' && !MEM.length) send({ type: 'memories' })
    if (TAB === 'settings') renderSettings()
    if (TAB === 'agents') renderAgents()
  }
})
$('#newchat').appendChild(icon('plus'))
$('#rescan').appendChild(icon('reload'))
tips()                                   // the header row
$('#newchat').onclick = () => send({ type: 'newChat' })
// the title-bar icon only exists in the sidebar, so the button lives here too
$('#boardbtn').appendChild(icon('pulse'))
$('#boardbtn').onclick = () => send({ type: 'openBoard' })
$('#dash').appendChild(icon('chart'))
$('#dash').onclick = () => send({ type: 'dashboard' })
$('#rescan').title = 'Refresh · hold Alt to re-read every chat from scratch'
$('#rescan').onclick = e => {
  const deep = e.altKey
  $('#rescan').classList.add('spin')
  setTimeout(() => $('#rescan').classList.remove('spin'), deep ? 1600 : 400)
  send({ type: 'rescan', deep })
  send({ type: 'refreshLimits' })
}

// ---------------------------------------------------------------- plan limits
const until = ms => {
  const m = Math.max(0, Math.round((ms - Date.now()) / 6e4))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/* The bar shows capacity LEFT, the way Claude's own usage panel reads: a full green
   bar means the window is untouched. The exact "x% used" sits in the hover card. */
let LIMITS = null            // the last reading, so Settings can show what is live
// The countdowns are worked out when drawn, and a reading arrives about once a
// minute - so "resets in 12m" sat still between readings. Redrawn on a clock
// instead, except under the pointer, where a redraw would close the hover card.
setInterval(() => {
  if (!LIMITS || document.hidden) return
  if (document.querySelector('#limits:hover, #lnudges:hover, #bnudges:hover')) return
  drawLimits(null)
}, 15000)
let CFG = {}                 // the extension's own settings, mirrored from the host

function drawLimits (l) {
  LIMITS = l || LIMITS
  l = LIMITS || { items: [] }
  const wrap = $('#limits')
  // Settings chooses which bars appear and in what order; with nothing chosen
  // the strip is hidden outright rather than falling back to all of them.
  const want = Array.isArray(CFG.topBars) ? CFG.topBars : null
  const byKey = new Map((l.items || []).map(x => [x.key, x]))
  const items = want
    ? want.map(b => byKey.get(b.key)).filter(Boolean)
    : (l.items || []).filter(x => x.key !== 'weekly_all' || !l.items.some(y => y.key === 'weekly_scoped'))
  // a colour from settings goes into a style attribute, so it must be only a colour
  const colorFor = x => { const c = want ? (want.find(b => b.key === x.key)?.color || '') : ''; return /^#[0-9a-f]{3,8}$/i.test(c) ? c : '' }
  if (!items.length) { wrap.innerHTML = ''; $('#lnudges').innerHTML = ''; if ($('#bnudges')) $('#bnudges').innerHTML = ''; return }
  const tone = x => x.key === 'session' ? 'five' : 'week'
  const age = l.fetchedAt ? ago(l.fetchedAt) + ' ago' : 'unknown'
  const cooling = l.coolUntil && l.coolUntil > Date.now()
  const note = cooling ? `${esc(l.lastError || 'refresh paused')} · retry in ${until(l.coolUntil)}`
    : l.lastError ? esc(l.lastError) : ''

  // against the clock: about to reset mostly unused, or on course to run out
  const flag = x => x.pace?.runoutIn ? 'runout' : x.pace?.unused ? 'unused' : x.pace?.soon ? 'soon' : ''
  const pctText = x => x.pace?.unused ? `${Math.max(0, 100 - x.percent)}% unused` : `${Math.max(0, 100 - x.percent)}% left`
  const resetText = x => x.stale ? 'last known'
    : x.pace?.runoutIn ? `runs out in ~${until(Date.now() + x.pace.runoutIn)}`
      : x.resetsAt ? 'resets in ' + until(x.resetsAt) : ''
  const advice = items.map(x => x.pace?.unused
    ? `${esc(x.label)} resets in ${until(x.resetsAt)} with ${100 - x.percent}% unused - a good time to use it.`
    : x.pace?.runoutIn
      ? `${esc(x.label)} is being used faster than its window allows: at this pace it runs out in ~${until(Date.now() + x.pace.runoutIn)}, but only resets in ${until(x.resetsAt)}.`
      : '').filter(Boolean)

  // the hover card is easy to miss, so a flagged window also gets a line of
  // its own under the bars. Dismissing it is a snooze, not goodbye: the
  // extension brings it back as the deadline closes in or the flag gets worse
  // resetting soon counts too, whatever is left: it is the last call either way
  // a window that has already reset is done, whatever the last reading said
  const nudges = items.filter(x => (x.pace?.unused || x.pace?.runoutIn || (x.pace?.soon && x.percent < 100)) &&
    !x.nudgeHidden && !(x.resetsAt && x.resetsAt <= Date.now()))

  // outside the strip, so pointing at one does not pop the hover card over it
  $('#lnudges').innerHTML = `
    ${nudges.map(x => `<div class="lnudge ${flag(x)}" data-key="${esc(x.key)}">
      <span>${x.pace.runoutIn
        ? `<b>${esc(x.label)}</b> runs out in ~${until(Date.now() + x.pace.runoutIn)} at this pace · resets in ${until(x.resetsAt)}`
        : x.pace.unused
          ? `<b>${esc(x.label)}</b> ${100 - x.percent}% unused · resets in ${until(x.resetsAt)}`
          : `<b>${esc(x.label)}</b> resets in ${until(x.resetsAt)} · ${100 - x.percent}% left`}</span>
      <button class="lnx" title="Hide for now - it comes back as the deadline gets closer" aria-label="Hide"><svg class="outline" viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></div>`).join('')}`
  wrap.innerHTML = `
    <div class="lbars">${items.map(x => `
      <i class="lbar ${tone(x)} ${/^(normal|warning|critical)$/.test(x.severity) ? x.severity : 'normal'}${x.stale ? ' stale' : ''} ${flag(x)}">
        <b style="width:${Math.max(0, 100 - Math.min(100, x.percent))}%${
          colorFor(x) ? `;background:${esc(colorFor(x))}` : ''}"></b></i>`).join('')}</div>
    <div class="lcard">
      ${items.map(x => `
        <div class="lrow">
          <em class="${tone(x)}"${colorFor(x) ? ` style="background:${esc(colorFor(x))}"` : ''}></em>
          <span class="lname">${esc(x.label)}</span>
          <span class="lpct ${flag(x)}">${pctText(x)}</span>
          <span class="lreset ${flag(x)}">${resetText(x)}</span>
        </div>`).join('')}
      ${advice.map(a => `<div class="ladvice">${a}</div>`).join('')}
      <div class="lfoot">${items.map(x => `${esc(x.label)} ${x.percent}% used`).join(' · ')}
        <span>read ${age} <button id="lrefresh" title="Fetch usage again" aria-label="Fetch usage again">↻</button></span></div>
      ${note ? `<div class="lwarn">${note}</div>` : ''}
    </div>`
  $('#lrefresh').onclick = ev => { ev.stopPropagation(); send({ type: 'refreshLimits' }) }
  // the board carries the same lines at its top
  if ($('#bnudges')) $('#bnudges').innerHTML = $('#lnudges').innerHTML
  for (const b of document.querySelectorAll('#lnudges .lnx, #bnudges .lnx')) {
    b.onclick = ev => {
      ev.stopPropagation()
      send({ type: 'dismissNudge', key: b.parentElement.dataset.key })
      b.parentElement.remove()
    }
  }
}

// ---------------------------------------------------------------- list
// One filter across the top, folders underneath - the way a messaging app reads.
const bucket = s => s.project || '~'

/** The chip row: All, Favourites, then every group Cursor knows about. */
/**
 * The source picker. Hidden outright when every chat came from the same CLI -
 * a filter with one option is furniture.
 */
function renderSources () {
  const host = $('#source')
  if (!host) return
  const counts = new Map()
  for (const s of SESSIONS) {
    if (s.archived) continue
    const k = s.provider || 'claude'
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  if (counts.size < 2) { host.hidden = true; SOURCE = 'all'; return }
  host.hidden = false
  // marks only, no label: it shares a row with the search box and the marks
  // already say which sources are in play
  host.replaceChildren()
  const showing = SOURCES[SOURCE] ? [SOURCE] : [...counts.keys()].filter(k => SOURCES[k])
  for (const k of showing) host.appendChild(sourceIcon(k))
  host.appendChild(el('span', 'tcaret', '▾'))
  host.title = SOURCES[SOURCE]
    ? `Showing ${SOURCES[SOURCE].label} only` : 'All sources - click to filter by CLI'

  host.onclick = e => {
    e.stopPropagation()
    document.querySelectorAll('body > .menu.srcmenu').forEach(m => m.remove())
    const menu = el('div', 'menu srcmenu')
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const row = (key, label, n, ico) => {
      const b = el('button', 'menuitem' + (SOURCE === key ? ' on' : ''))
      b.append(ico, el('span', '', label), el('em', '', String(n)))
      b.onclick = () => { SOURCE = key; menu.remove(); SHOWN.clear(); renderSources(); renderList() }
      menu.appendChild(b)
    }
    row('all', 'All sources', total, icon('list', 'mico'))
    for (const [key, sp] of Object.entries(SOURCES)) {
      if (counts.has(key)) row(key, sp.label, counts.get(key), sourceIcon(key))
    }
    document.body.appendChild(menu)
    const b = host.getBoundingClientRect()
    const m = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - m.width - 8))}px`
    menu.style.top = `${Math.min(b.bottom + 4, window.innerHeight - m.height - 8)}px`
    dismissOn(menu)
  }
}

function renderChips () {
  const bar = $('#chips')
  bar.innerHTML = ''
  const counts = new Map()
  let pinned = 0
  for (const s of SESSIONS) {
    if (s.archived) continue
    if (s.pinned) pinned++
    if (s.group) counts.set(s.group, (counts.get(s.group) || 0) + 1)
  }
  const chip = (key, label, n, isGroup) => {
    const b = el('button', 'chip' + (FILTER === key ? ' on' : ''))
    b.setAttribute('aria-pressed', String(FILTER === key))
    b.appendChild(el('span', '', label))
    if (n) b.appendChild(el('em', '', String(n)))
    b.onclick = () => { FILTER = key; SHOWN.clear(); renderList() }
    // right-click a group chip to rename or remove it
    b.oncontextmenu = e => { e.preventDefault(); chipMenu(e, isGroup ? label : null) }
    bar.appendChild(b)
  }
  chip('all', 'All')
  if (pinned) chip('pinned', 'Favourites', pinned)
  for (const name of GROUPS) if (!counts.has(name)) counts.set(name, 0)
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) chip(name, name, n, true)
  if (TRASHED.length) chip('deleted', 'Deleted', TRASHED.length)

  const add = el('button', 'chip add')
  add.appendChild(el('span', '', '+'))
  add.title = 'New group · shared with the Claude Code extension'
  add.onclick = () => send({ type: 'group', create: true, ask: true })
  add.oncontextmenu = e => { e.preventDefault(); chipMenu(e, null) }
  bar.appendChild(add)
}

/** Right-click menu on a group chip: make, rename or remove a group. */
function chipMenu (e, name) {
  document.querySelector('.ctx')?.remove()
  const menu = el('div', 'ctx')
  const item = (label, fn, danger) => {
    const b = el('button', 'ctxitem' + (danger ? ' danger' : ''))
    b.append(el('span', '', label))
    b.onclick = ev => { ev.stopPropagation(); menu.remove(); fn() }
    menu.appendChild(b)
  }
  item('New group…', () => send({ type: 'group', create: true, ask: true }))
  if (name) {
    item('Rename group…', () => send({ type: 'group', rename: name, ask: true }))
    menu.appendChild(el('div', 'ctxsep'))
    item('Delete group…', () => send({ type: 'group', remove: name, confirm: true }), true)
  }
  document.body.appendChild(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - box.height - 8)}px`
  dismissOn(menu)
}

/**
 * Close a floating menu on anything that means "I am done with it": a click
 * outside it, a right-click elsewhere, Escape, scrolling underneath, or the
 * panel losing focus. A plain click listener never fires when you click outside
 * the webview, which left menus stranded on screen.
 *
 * `close` is for a panel that is reused rather than thrown away - it is called
 * instead of removing the element.
 */
function dismissOn (menu, close) {
  const kill = () => {
    if (close) close(); else menu.remove()
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('contextmenu', onCtx, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', kill)
    for (const n of scrollers) n.removeEventListener('scroll', onScroll, true)
  }
  // scrolling the page under it closes it; scrolling inside it - a long agents
  // list - is just reading it
  const onScroll = e => { if (!menu.contains(e.target)) kill() }
  // a click inside the menu is the action itself - those items close it themselves
  const onClick = e => { if (!menu.contains(e.target)) kill() }
  const onCtx = e => { if (!menu.contains(e.target)) kill() }
  const onKey = e => { if (e.key === 'Escape') kill() }
  const scrollers = [...document.querySelectorAll('#rows, .msgs, #memrows, .view')]
  setTimeout(() => {
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onCtx, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', kill)
    for (const n of scrollers) n.addEventListener('scroll', onScroll, true)
  }, 0)
  return kill
}

// Two independent axes: the group chips say which chats, the source button
// says which CLI wrote them. A chat has to pass both.
let SOURCE = 'all'
const matches = s =>
  (SOURCE === 'all' || (s.provider || 'claude') === SOURCE) &&
  (FILTER === 'all' ? true : FILTER === 'pinned' ? s.pinned : s.group === FILTER)

/**
 * Never rebuild the list under the pointer. The list is redrawn whenever a
 * transcript is written and while search results stream in, and a row replaced
 * between pressing and releasing the mouse never receives the click - which is
 * why a click sometimes did nothing and the second one worked. While a button
 * is held over the panel the redraw waits, and runs once it is released.
 */
let HELD = false, HELD_REDRAW = false
document.addEventListener('pointerdown', e => {
  if (e.button === 0 && e.target.closest('#rows, #view-chats')) HELD = true
}, true)
const release = () => {
  if (!HELD) return
  HELD = false
  // let the click that this release produces run against the current rows first
  if (HELD_REDRAW && !HOVER) { HELD_REDRAW = false; setTimeout(() => { if ($('#detail').hidden) renderList() }, 0) }
}
document.addEventListener('pointerup', release, true)
document.addEventListener('pointercancel', release, true)
window.addEventListener('blur', release)

// Holding only while the button is down was not enough: with busy chats the
// list re-sorts every second, and a row could slide away between pointing at
// it and pressing - the click then landed on its neighbour, and Resume opened
// the wrong chat. So the rows also hold still while the pointer is over them,
// and catch up the moment it leaves.
let HOVER = false
$('#rows').addEventListener('pointerenter', () => { HOVER = true })
$('#rows').addEventListener('pointerleave', () => {
  HOVER = false
  if (HELD_REDRAW && !HELD) { HELD_REDRAW = false; if ($('#detail').hidden) renderList() }
})

/** A redraw nobody asked for - a chat wrote, the running state moved: never under the pointer. */
function liveRender () {
  if (HOVER) { HELD_REDRAW = true; return }
  renderList()
}

function renderList () {
  if (RENAMING) return        // a live redraw would throw away what you are typing
  if (HELD) { HELD_REDRAW = true; return }
  renderSources()
  draw()
  fillViewport()
}

// ---------------------------------------------------------------- resources
// What running chats cost the laptop, and commands Claude left behind. Only the
// exceptions are shown in the list - a badge on a chat that is heavy, a banner
// for a leftover that is still eating CPU or memory - since the normal case is
// a few hundred megabytes and nothing to act on.
let RES = null
const HEAVY_MB = 1500, HEAVY_CPU = 90           // a chat worth flagging
const LEFT_MB = 500, LEFT_CPU = 20              // a leftover worth flagging
const mbText = mb => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB')
const heavy = r => !!r && (r.mb >= HEAVY_MB || r.cpu >= HEAVY_CPU)
// named, not just numbers: "223 MB" alone did not say what it measured
const resText = r => `RAM ${mbText(r.mb)} · CPU ${r.cpu}%`
const heavyLeftovers = () => (RES?.leftovers || []).filter(x => x.mb >= LEFT_MB || x.cpu >= LEFT_CPU)

function resBadge (id) {
  const r = RES?.sessions?.[id]
  if (!heavy(r)) return null
  const b = el('span', 'resbadge', r.cpu >= HEAVY_CPU ? `CPU ${r.cpu}%` : `RAM ${mbText(r.mb)}`)
  b.title = `This chat and everything it started: ${mbText(r.mb)}, ${r.cpu}% CPU, ${r.procs} processes`
  return b
}

function leftoverBanner () {
  const list = heavyLeftovers()
  if (!list.length) return null
  const box = el('div', 'leftovers')
  box.appendChild(el('div', 'lohead', list.length === 1
    ? 'A command Claude left running is using your laptop'
    : `${list.length} commands Claude left running are using your laptop`))
  for (const x of list) {
    const row = el('div', 'lorow')
    const txt = el('div', 'lotxt')
    txt.append(el('b', '', resText(x)),
      el('span', '', `running for ${x.up.replace(/-/, ' days ')}`))
    const cmd = el('code', 'locmd', x.cmd.split('\n')[0].slice(0, 80))
    cmd.title = x.cmd
    txt.appendChild(cmd)
    const stop = el('button', 'lostop', 'Stop')
    stop.title = 'Asks before stopping anything'
    stop.onclick = () => send({ type: 'stopProcess', pid: x.pid })
    row.append(txt, stop)
    box.appendChild(row)
  }
  return box
}

/** Update the badges, banner and footer in place - no redraw of the list. */
function paintResources () {
  for (const row of document.querySelectorAll('#rows .row[data-id]')) {
    row.querySelector('.resbadge')?.remove()
    const b = resBadge(row.dataset.id)
    if (b) row.querySelector('.age')?.before(b)
  }
  const rows = $('#rows')
  rows.querySelector('.leftovers')?.remove()
  const ban = leftoverBanner()
  if (ban) rows.prepend(ban)
  const st = $('#detail .resstat')
  if (st && CUR) {
    const r = RES?.sessions?.[CUR.id]
    const grp = st.closest('.resgroup')
    if (grp && grp.hidden !== !r) { grp.hidden = !r; restack(grp.parentElement) }
    if (r) {
      st.textContent = resText(r)
      st.classList.toggle('hot', heavy(r))
    }
  }
}

function draw () {
  const q = $('#q').value.trim().toLowerCase()
  if (FILTER === 'deleted' && !TRASHED.length) FILTER = 'all'
  renderChips()
  if (FILTER === 'deleted') return drawDeleted(q)
  // Titles first. A folder or group name is only a fallback for when no title
  // matches: a word that also names the folder nearly everything lives in, like
  // the workspace name, otherwise matched every chat, so nothing visibly filtered
  // and the message results ended up below the whole list.
  const pool = SESSIONS.filter(matches)
  const byTitle = pool.filter(s => !q || s.title.toLowerCase().includes(q))
  const byName = (s, field) => (s[field] || '').toLowerCase().includes(q)
  const list = !q || byTitle.length ? byTitle
    : pool.filter(s => byName(s, 'group') || byName(s, 'project'))
  const map = new Map()
  for (const s of list) { const b = bucket(s); if (!map.has(b)) map.set(b, []); map.get(b).push(s) }
  // the folders this window has open float to the top, then everything else;
  // within each, the most recently active first. Ranking by chat count buried a folder with today's chats under one
  // with many old ones, so new chats looked like they never arrived.
  const latest = new Map([...map].map(([k, v]) => [k, v.reduce((m, s) => Math.max(m, s.lastTs || 0), 0)]))
  const keys = [...map.keys()].sort((a, b) =>
    (isHere(b) ? 1 : 0) - (isHere(a) ? 1 : 0) || latest.get(b) - latest.get(a))

  const rows = $('#rows'); rows.innerHTML = ''
  const ban = leftoverBanner()
  if (ban) rows.appendChild(ban)
  GROUPSIZE.clear()
  // this window's folders start open and everything else starts shut, so the
  // list reads as this project's chats. A window with no folder opens the most recent.
  const home = new Set(keys.filter(isHere))
  if (!home.size && keys.length) home.add(keys[0])
  for (const k of keys) {
    const all = map.get(k)
    GROUPSIZE.set(k, all.filter(s => !s.archived || ARCH.has(k)).length)
    const hidden = all.filter(s => s.archived).length
    // pinned float to the top of their group; archived drop out unless asked for
    const items = all
      .filter(s => !s.archived || ARCH.has(k))
      .sort(order)
    // a search opens every folder, so a match is never hidden behind a shut one
    const flip = q || home.has(k) ? SHUT : OPENED
    const open = flip === SHUT ? !SHUT.has(k) : OPENED.has(k)
    rows.appendChild(ghead(k, all, open, flip))
    if (!open) continue
    const cap = q ? items.length : Math.min(items.length, SHOWN.get(k) || PAGE)
    for (const s of items.slice(0, cap)) rows.appendChild(chatRow(s))
    if (cap < items.length) {
      const more = el('div', 'more', `Show ${Math.min(MORE, items.length - cap)} more`)
      more.onclick = () => { SHOWN.set(k, cap + MORE); renderList() }
      rows.appendChild(more)
    }
    if (hidden) {
      const t = el('div', 'more', `${hidden} archived · ${ARCH.has(k) ? 'hide' : 'show'}`)
      t.onclick = () => { ARCH.has(k) ? ARCH.delete(k) : ARCH.add(k); renderList() }
      rows.appendChild(t)
    }
  }
  tips(rows)                             // row actions, rebuilt on every draw
  if (!list.length && !RESULTS && !SEARCHING) {
    rows.appendChild(el('div', 'empty', q ? 'No chats match that.' : FILTER !== 'all' ? 'No chats in this filter.' : 'No chats yet.'))
  }
  if (q.length >= 2) rows.appendChild(messageMatches(q))

  const spend = list.reduce((n, s) => n + s.cost, 0)
  // the chip row scrolls, so name the active filter here too
  const filterName = FILTER === 'all' ? '' : ` in ${FILTER === 'pinned' ? 'Favourites' : FILTER}`
  $('#listmeta').textContent =
    `${list.length} sessions${filterName}` + (spend ? ` · ${money(spend)}` : '')
}

/** The Deleted chip: chats moved out of the list, each with Restore. */
function drawDeleted (q) {
  const list = TRASHED.filter(x =>
    (SOURCE === 'all' || x.provider === SOURCE) && (!q || x.title.toLowerCase().includes(q)))
  const rows = $('#rows'); rows.innerHTML = ''
  rows.appendChild(el('div', 'delnote', 'Deleted chats stay on this laptop. Restore puts one back where it was.'))
  for (const x of list) {
    const r = el('div', 'row deleted')
    r.appendChild(sourceIcon(x.provider))
    r.append(el('span', 't', x.title), el('span', 'age', ago(x.deletedAt)))
    const b = el('button', 'restorebtn', 'Restore')
    b.onclick = e => { e.stopPropagation(); b.disabled = true; send({ type: 'restore', name: x.name }) }
    r.appendChild(b)
    r.title = `${x.project} · ${x.messages} messages · deleted ${ago(x.deletedAt)} ago`
    rows.appendChild(r)
  }
  if (!list.length) rows.appendChild(el('div', 'empty', 'No deleted chats match that.'))
  $('#listmeta').textContent = `${list.length} deleted`
}

/**
 * The whole chat arriving under its quick first copy. The messages on screen
 * are the same ones, only numbered from the copy's own start, so they are
 * renumbered and kept rather than drawn again - a second full draw was a
 * visible hitch just after a chat opened. Anything that does not line up falls
 * back to drawing afresh.
 */
function fillInPlace (t) {
  const body = $('.msgs')
  if (!body || !CUR || !LAST_SIGS.length) return false
  const blocks = collapse(t.turns)
  const sigs = sigsOf(blocks, t)
  const off = blocks.length - LAST_SIGS.length
  const toff = t.turns.length - CUR.turns.length
  if (off < 0 || toff < 0) return false
  // agent states come only with the whole chat, so they are left out of the match
  const bare = s => s.slice(0, s.lastIndexOf('|'))
  for (let i = SHOWN_FROM; i < LAST_SIGS.length; i++) {
    if (bare(sigs[i + off]) !== bare(LAST_SIGS[i])) return false
  }
  for (const n of body.children) if (n.dataset.bi) n.dataset.bi = Number(n.dataset.bi) + off
  const shift = k => { const [a, b] = k.split(':').map(Number); return `${a + toff}:${b}` }
  // all moved at once: an old number can equal another picture's new one
  const moves = []
  for (const fig of body.querySelectorAll('.shot[data-key]')) {
    const key = fig.dataset.key
    moves.push({ fig, key, p: PENDING.get(key), asked: ASKED.has(key) })
    PENDING.delete(key); ASKED.delete(key)
  }
  for (const m of moves) {
    m.fig.dataset.key = shift(m.key)
    // still waiting on a picture asked for by the old number: ask again by the new one
    if (m.p) { PENDING.set(m.fig.dataset.key, m.p); if (m.asked) SEEN.observe(m.fig) }
  }
  SHOWN_FROM += off
  ALL_BLOCKS = blocks
  LAST_SIGS = sigs.slice(0, off).concat(LAST_SIGS)
  CUR = t
  // the footer, the agents button and any agent card that changed, as for a live write
  return updateLive(t)
}

/**
 * Running or not. Busy and idle deliberately rank the same: a busy session is
 * by definition the most recently active, so recency already floats it, and
 * ranking it higher would only make rows hop as Claude starts and stops.
 */
const liveRank = s => s.live ? 1 : 0

/**
 * Pinned first, then whatever is actually running, then the configured sort.
 * There is deliberately no unread rank: a chat read in the terminal still
 * looked unread here, so the marker drew the eye to the wrong rows.
 */
function order (a, b) {
  const p = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  if (p) return p
  if (LIVE_FIRST) {
    const l = liveRank(b) - liveRank(a)
    if (l) return l
  }
  if (SORT === 'cost') return b.cost - a.cost
  if (SORT === 'messages') return b.messages - a.messages
  if (SORT === 'title') return a.title.localeCompare(b.title)
  return b.lastTs - a.lastTs
}

const isHere = name => HERE.has(name)

/**
 * Keep the list as long as the panel is tall. A fixed page left dead space on a
 * big window and a cramped list on a small one; this grows each folder until the
 * rows actually reach the bottom.
 */
function fillViewport () {
  const box = $('#rows')
  if (!box) return
  requestAnimationFrame(() => {
    let guard = 0
    while (box.scrollHeight <= box.clientHeight + 40 && guard++ < 12) {
      let grew = false
      for (const [k, total] of GROUPSIZE) {
        const at = SHOWN.get(k) || PAGE
        if (at >= total) continue
        SHOWN.set(k, at + Math.max(6, Math.ceil(box.clientHeight / 42)))
        grew = true
      }
      if (!grew) return
      draw()
    }
  })
}

/** More rows as you reach the end, rather than a button for every batch. */
function onListScroll () {
  const box = $('#rows')
  if (!box || box.scrollTop + box.clientHeight < box.scrollHeight - 160) return
  let grew = false
  for (const [k, total] of GROUPSIZE) {
    const at = SHOWN.get(k) || PAGE
    if (at >= total) continue
    SHOWN.set(k, at + MORE)
    grew = true
    break                                  // one folder at a time, in order
  }
  if (grew) draw()
}
const GROUPSIZE = new Map()

/** Search results: a summary line, then one card per chat, expandable to its hits. */
function messageMatches (q) {
  const wrap = el('div', 'found')
  if (SEARCHING) {
    wrap.appendChild(el('div', 'fsum', 'Searching messages…'))
    return wrap
  }
  if (!RESULTS) return wrap

  const sum = el('div', 'fsum')
  const stat = (n, label) => {
    const b = el('div', 'fstatbox')
    b.append(el('b', '', String(n)), el('span', '', label))
    return b
  }
  sum.append(stat(RESULTS.chats.length, RESULTS.chats.length === 1 ? 'chat' : 'chats'),
    stat(RESULTS.matches, RESULTS.matches === 1 ? 'match' : 'matches'))
  const meta = el('div', 'fmeta')
  meta.append(el('span', '', RESULTS.streaming ? 'still looking…' : `${RESULTS.ms}ms`),
    el('span', '', `read ${RESULTS.scanned} of ${RESULTS.total} chats`))
  if (RESULTS.truncated) meta.appendChild(el('span', 'warn', `first ${RESULTS.chats.length} shown`))
  if (RESULTS.failed) meta.appendChild(el('span', 'warn', 'search stopped before finishing'))
  sum.appendChild(meta)
  const clear = el('button', 'fclear', 'Clear')
  clear.onclick = () => $('#qclear').onclick()
  sum.appendChild(clear)
  wrap.appendChild(sum)

  if (!RESULTS.chats.length) {
    wrap.appendChild(el('div', 'empty', RESULTS.streaming ? 'Searching messages…'
      : RESULTS.failed ? 'The search stopped before finishing. Type again to retry.'
        : `Nothing matches "${q}" inside any chat.`))
    return wrap
  }

  for (const c of RESULTS.chats) {
    const card = el('div', 'fcard')
    const head = el('div', 'fhead2')
    const chev = el('span', 'chev2', '›')
    const live = SESSIONS.find(x => x.id === c.id)?.live
    head.append(chev, sourceIcon(c.provider), el('span', 't', c.title))
    if (live) head.appendChild(el('span', live === 'busy' ? 'spinner' : 'dot idle'))
    const badge = el('span', 'count', String(c.total))
    badge.title = `${c.total} match${c.total === 1 ? '' : 'es'} in this chat`
    head.appendChild(badge)

    // Open sits on the header row - the facts line is for reading, not acting
    // resume straight from a result, without opening the chat first - it goes
    // wherever Resume is set to, and to a terminal already running it if one is
    const resume = el('button', 'fresume')
    resume.appendChild(icon('play', 'fresico'))
    resume.title = 'Resume this chat'
    resume.onclick = e => { e.stopPropagation(); send({ type: 'resume', id: c.id }) }
    const open = el('button', 'fopen', 'Open')
    open.onclick = e => { e.stopPropagation(); openAt(c.id, q) }
    head.append(resume, open)

    const facts = el('div', 'ffacts')
    facts.append(el('span', '', clock(c.lastTs)),
      el('span', '', c.project),
      el('span', '', `${c.messages} messages`))

    const hits = el('div', 'fhits')
    // a live refresh redraws the list, so the open cards are remembered
    hits.hidden = !OPENHITS.has(c.id)
    chev.textContent = hits.hidden ? '›' : '⌄'
    for (const h of c.hits) {
      const line = el('div', 'fhit' + (h.role === 'user' ? ' you' : ''))
      const WHO = { user: 'You', assistant: 'Claude', agent: 'Agent', session: 'Session' }
      line.append(el('span', 'who', WHO[h.role] || 'Claude'), mark(h.text, q))
      line.onclick = () => openAt(c.id, q)
      hits.appendChild(line)
    }
    if (c.total > c.hits.length) {
      hits.appendChild(el('div', 'fmore', `${c.total - c.hits.length} more in this chat`))
    }

    head.onclick = () => {
      hits.hidden = !hits.hidden
      hits.hidden ? OPENHITS.delete(c.id) : OPENHITS.add(c.id)
      chev.textContent = hits.hidden ? '›' : '⌄'
    }
    card.append(head, facts, hits)
    wrap.appendChild(card)
  }
  // the search stops at SEARCH_LIMIT chats; this asks again for the next 60.
  // The ones already here stream back first and are skipped, so nothing jumps
  if (RESULTS.truncated && !RESULTS.streaming) {
    const more = el('div', 'more', 'Show 60 more chats')
    more.onclick = () => {
      SEARCH_LIMIT = RESULTS.chats.length + 60
      RESULTS.streaming = true
      renderList()
      send({ type: 'search', q: RESULTS.q, limit: SEARCH_LIMIT })
    }
    wrap.appendChild(more)
  }
  return wrap
}

/** A snippet with the matched phrase highlighted, built without innerHTML. */
function mark (text, q) {
  const span = el('span', 'snip')
  const re = new RegExp(rx(q), 'gi')
  let last = 0, m
  while ((m = re.exec(text))) {
    if (m.index > last) span.appendChild(document.createTextNode(text.slice(last, m.index)))
    span.appendChild(el('mark', '', m[0]))
    last = m.index + m[0].length
  }
  span.appendChild(document.createTextNode(text.slice(last)))
  return span
}

/** Open a chat and run the same phrase through its in-chat find. */
function openAt (id, q) {
  JUMP = q
  PERF = { id, t0: performance.now() }
  send({ type: 'session', id })
}
let JUMP = ''
let PERF = null   // timing of an open from search, written to the host's log

function ghead (name, items, open, flip) {
  const h = el('div', 'ghead' + (open ? '' : ' shut'))
  h.append(icon('chevron', 'chev'), icon('folder', 'gfolder'), el('span', 'gname', name))
  if (isHere(name)) h.appendChild(el('span', 'badge', 'current'))
  h.appendChild(el('span', 'gcount', String(items.length)))
  // Codex carries no price, so a folder of only Codex chats says nothing
  // rather than claiming it cost nothing
  const spend = items.reduce((n, s) => n + s.cost, 0)
  if (spend) h.appendChild(el('span', 'gcost', money(spend)))
  h.onclick = () => { flip.has(name) ? flip.delete(name) : flip.add(name); renderList() }
  return h
}

function chatRow (s) {
  const r = el('div', 'row' + (s.pinned ? ' pinned' : '') + (s.archived ? ' archived' : ''))
  r.dataset.id = s.id            // rename and the row menu look the row up by this
  r.appendChild(sourceIcon(s.provider))
  if (s.pinned) r.appendChild(icon('pin', 'pinmark'))
  if (s.branchedFrom) r.appendChild(icon('fork', 'branchmark'))
  r.append(el('span', 't', s.title))
  const rb = resBadge(s.id)
  if (rb) r.appendChild(rb)
  r.appendChild(el('span', 'age', ago(s.lastTs)))
  // busy gets a turning ring, idle a steady dot, anything else nothing at all
  r.appendChild(el('span',
    s.live === 'busy' ? 'spinner' : 'dot' + (s.live === 'idle' ? ' idle' : ' off')))

  // hover actions, floated over the right edge like the row's own toolbar
  const acts = el('div', 'rowacts')
  const act = (name, tip, fn) => {
    const b = el('button', 'ract')
    b.appendChild(icon(name))
    b.title = tip
    b.onclick = e => { e.stopPropagation(); fn(e) }
    return b
  }
  acts.append(
    // rename sits where pin was: renaming is the frequent one, pin lives in the right-click menu
    act('pencil', 'Rename', () => renamePrompt(s)),
    act('play', 'Resume in a terminal', () => send({ type: 'resume', id: s.id, target: 'terminal' })),
    act('archive', s.archived ? 'Unarchive' : 'Archive', () => send({ type: 'archive', id: s.id })),
    act('trash', 'Delete chat', () => send({ type: 'trash', id: s.id })))
  r.appendChild(acts)

  r.title = `${s.project} · ${s.messages} messages · ${nfmt(s.tokens)} tokens · ${money(s.cost)}`
  r.onclick = () => { (PERF = { id: s.id, t0: performance.now() }, send({ type: 'session', id: s.id })) }
  warmOnHover(r, s.id)
  r.oncontextmenu = e => { e.preventDefault(); rowMenu(s, e.clientX, e.clientY) }
  return r
}
let searchTimer = null
$('#q').oninput = () => {
  const q = $('#q').value.trim()
  $('#qclear').hidden = !q
  RESULTS = null
  SEARCH_LIMIT = 60
  renderList()                       // titles filter as you type
  clearTimeout(searchTimer)
  if (q.length < 2) return
  // reading 389MB is not something to do on every keystroke
  searchTimer = setTimeout(() => { SEARCHING = q; renderList(); send({ type: 'search', q, limit: SEARCH_LIMIT }) }, 350)
}
$('#qclear').onclick = () => {
  clearTimeout(searchTimer)
  RESULTS = null; SEARCHING = ''; SEARCH_LIMIT = 60; OPENHITS.clear()
  $('#q').value = ''
  $('#qclear').hidden = true
  $('#q').focus()
  renderList()
}
$('#q').onkeydown = e => { if (e.key === 'Escape') $('#qclear').onclick() }

// ------------------------------------------------- images, fetched when visible
const PENDING = new Map()          // "turn:index" -> the elements waiting for bytes
const ASKED = new Set()

const SEEN = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    const key = e.target.dataset.key
    SEEN.unobserve(e.target)
    if (!CUR || ASKED.has(key)) continue
    ASKED.add(key)
    const [ti, ii] = key.split(':').map(Number)
    send({ type: 'image', id: CUR.id, ti, ii, part: !!CUR.part })
  }
}, { rootMargin: '400px' })        // start loading just before it scrolls in

/**
 * Let go of images that are leaving the screen. The observer that loads them
 * keeps hold of every element it is watching, removed from the page or not, and
 * through it the whole old copy of the chat - so a chat redrawn often, in a
 * long session with screenshots, left a full copy behind each time and memory
 * climbed for hours. Called for everything a redraw or close removes.
 */
function releaseImages (root) {
  if (!root) return
  for (const fig of root.querySelectorAll('.shot[data-key]')) {
    SEEN.unobserve(fig)
    const key = fig.dataset.key
    PENDING.delete(key)
    // asked for but replaced: the new copy has to ask again or it stays loading
    ASKED.delete(key)
  }
}

function putImage (m) {
  const hit = PENDING.get(`${m.ti}:${m.ii}`)
  if (!hit) return
  if (m.src) hit.img.src = m.src
  hit.fig.classList.remove('loading')
  if (!m.src) hit.fig.classList.add('gone')
  PENDING.delete(`${m.ti}:${m.ii}`)
}

// ---------------------------------------------------------------- detail
/**
 * A new chat has no transcript until its first message. Until then the panel
 * says so, in place of the chat it will become.
 */
let PENDING_CHAT = null
function showPending (id) {
  closeDetail()
  PENDING_CHAT = id
  $('#tabs').hidden = TAB === 'chats'   // a chat opened in the background must not take the tab row from another page
  $('#view-chats .bar').hidden = true
  $('#rows').hidden = true
  const d = $('#detail')
  d.hidden = false
  d.innerHTML = ''
  const top = el('div', 'dtop')
  const back = el('button', 'iconbtn', '‹')
  back.title = 'All chats'
  back.onclick = () => { PENDING_CHAT = null; closeDetail() }
  top.append(back, el('h2', '', 'New chat'))
  const head = el('div', 'dhead')
  head.appendChild(top)
  const wait = el('div', 'pendingchat')
  wait.append(el('span', 'spinner'), el('span', '', 'Started in a terminal. It opens here as soon as you send the first message.'))
  d.append(head, wait)
}

function closeDetail () {
  if (CUR) PENDING_CHAT = null
  CUR = null
  SEEN.disconnect()
  PENDING.clear(); ASKED.clear()
  document.querySelectorAll('body > .menu').forEach(m => m.remove())
  send({ type: 'closed' })
  $('#detail').hidden = true
  $('#rows').hidden = false
  $('#view-chats .bar').hidden = false
  $('#tabs').hidden = false
  // the list kept updating while a chat was open, but was not redrawn - a chat
  // started meanwhile only showed after a manual refresh
  renderList()
}

/** Collapse consecutive same-role turns so a run of tool calls is one block. */
/**
 * Keep the transcript's own rhythm: a reply, then the work it ran, then the next
 * reply. Only runs of pure tool calls merge - the text between them stays where
 * it was said, so the chat reads like the terminal it came from.
 */
function collapse (turns) {
  const out = []
  for (const t of turns) {
    const empty = !t.text
    const prev = out[out.length - 1]
    if (t.role === 'note') { out.push({ ...t, tools: [], images: [], edits: [] }); continue }
    // a bare tool call joins the run above it rather than starting a new block
    if (empty && prev && prev.role === t.role && !prev.images.length) {
      prev.tools.push(...t.tools)
      prev.images.push(...(t.images || []))
      prev.edits.push(...(t.edits || []))
      prev.ts = t.ts || prev.ts
      continue
    }
    out.push({ role: t.role, text: t.text, tools: [...t.tools],
      images: [...(t.images || [])], edits: [...(t.edits || [])], ts: t.ts })
  }
  return out.filter(t => t.text || t.tools.length || t.images.length || t.edits.length)
}

// ---------------------------------------------------------------- sub-agents
// Claude farms work out to background agents, each with its own transcript. They
// are the part of a chat that is otherwise invisible: the main thread only shows
// "launched" and later a conclusion, never the work in between.

/** "claude-opus-5-5[1m]" as people say it: "Opus 5.5 (1M)". A date stamp on the end is dropped. */
const modelName = m => {
  let s = String(m || '').replace(/^claude-/, '')
  if (/^gpt/i.test(s)) return s.replace(/^gpt/i, 'GPT').replace(/-codex/i, ' Codex')
  const big = /\[1m\]$/.test(s)
  s = s.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
    .replace(/^./, c => c.toUpperCase())
  return s + (big ? ' (1M)' : '')
}

// a running agent has run until now, not until its last line: Claude's own
// timer counts that way, and stopping at the last write made ours read short
const agentSpan = a => {
  const end = a.status === 'running' ? Date.now() : a.endTs
  return end && a.startTs && end > a.startTs ? dur(end - a.startTs) : ''
}

/** The line under a chat's title: its model, then its numbers. */
function chatFacts (t) {
  if (t.isAgent) return agentFacts(t)
  // replies name the plain model; the 1M window is known from the chat, not the name
  const m = t.info?.model ? modelName(t.info.model) : ''
  return [m && t.info.window >= 1e6 && !m.includes('1M') ? m + ' (1M)' : m,
    `${t.messages} messages`, `${t.edits} edits`, `${nfmt(t.tokens)} tokens`,
    // Codex bills against a plan, not per token, so there is no figure to show
    t.provider === 'codex' ? '' : money(t.cost), `${dur(t.activeMs)} active`].filter(Boolean).join(' · ')
}

/** The numbers under an agent's name, wherever it is shown. */
function agentFacts (a) {
  const f = []
  if (a.model) f.push(modelName(a.model))
  if (a.messages) f.push(a.messages + ' msg')
  if (a.tools) f.push(a.tools + ' tools')
  if (a.tokens) f.push(nfmt(a.tokens) + ' tokens')
  if (a.cost) f.push(money(a.cost))
  const d = agentSpan(a)
  if (d) f.push(d)
  return f.join(' · ')
}

const openAgent = (sessionId, agentId) => send({ type: 'agent', id: sessionId, agentId })

/**
 * The card shown in the chat where an agent was launched. The main thread
 * records only that it started, so everything here comes from the agent's own
 * transcript and from the notification it sent back when it finished.
 */
// a status is read from the transcript and becomes a class name, so only the known ones pass
const statusClass = st => /^(running|done|stopped|failed|killed)$/.test(st) ? st : 'other'

function agentCard (a, sessionId) {
  const c = el('div', 'acard ' + statusClass(a.status))
  const head = el('div', 'ahead')
  head.append(icon('agent', 'aico'), el('span', 'aname', a.description))
  if (a.agentType) head.appendChild(el('span', 'atype', a.agentType))
  head.appendChild(el('span', 'astate ' + statusClass(a.status), a.status))
  c.appendChild(head)
  c.appendChild(el('div', 'ameta', agentFacts(a)))

  // the brief it was given, and the answer it came back with - both folded away,
  // because an agent prompt is usually longer than the message that spawned it
  const fold = (label, text) => {
    if (!text) return
    const w = el('div', 'afold')
    const b = el('button', 'afoldhead')
    b.append(el('span', 'chev2', '›'), el('span', '', label))
    const body = el('div', 'afoldbody')
    body.innerHTML = window.md(text)
    body.hidden = true
    b.onclick = () => {
      body.hidden = !body.hidden
      b.querySelector('.chev2').textContent = body.hidden ? '›' : '⌄'
    }
    w.append(b, body)
    c.appendChild(w)
  }
  fold('Brief it was given', a.prompt)
  fold('What it reported back', a.result)

  const go = el('button', 'aopen')
  go.append(el('span', '', 'Open its thread'), icon('chevron', 'agoico'))
  go.onclick = () => openAgent(sessionId, a.id)
  c.appendChild(go)
  return c
}

/** Cards for every agent launched in this run of tool calls. */
function agentCards (tools, t) {
  const all = t.agents || []
  if (!all.length) return null
  const box = el('div', 'acards')
  for (const tool of tools) {
    if (!tool.useId) continue
    const a = all.find(x => x.toolUseId === tool.useId)
    if (!a) continue
    tool.card = true                 // so the tool line does not repeat it
    box.appendChild(agentCard(a, t.sessionId || t.id))
  }
  return box.children.length ? box : null
}

/**
 * The floating agents button and its panel. Shown as a tree, not a list: an
 * agent can spawn its own agents, and knowing which ones were somebody else's
 * idea is most of what the panel is for.
 */
function agentsFab (t, stage) {
  const all = t.agents || []
  if (!all.length) return
  const fab = el('button', 'afab')
  fab.dataset.sig = all.map(a => a.id + ':' + a.status).join(',')
  fab.appendChild(icon('agent', 'afabico'))
  fab.appendChild(el('span', 'afabn', String(all.length)))
  const running = all.filter(a => a.status === 'running').length
  fab.title = running ? `${all.length} agents, ${running} still running` : `${all.length} agents`
  if (running) fab.classList.add('busy')

  const panel = el('div', 'apanel')
  panel.hidden = true
  const ph = el('div', 'apanelhead')
  ph.append(icon('agent', 'apico'), el('span', 'aptitle', `Agents (${all.length})`))
  // not every agent finishes: some are killed, some fail, some just stop
  const doneN = all.filter(a => a.status === 'done').length
  ph.appendChild(el('span', 'apdone',
    running ? `${running} running`
      : doneN === all.length ? `${doneN} done` : `${doneN} of ${all.length} done`))
  panel.appendChild(ph)

  // children under their parent, each generation indented one step
  const kids = id => all.filter(a => (a.parent || null) === id)
  const line = (a, depth) => {
    const r = el('button', 'arow')
    r.style.paddingLeft = `${10 + depth * 16}px`
    r.append(el('span', 'adot ' + statusClass(a.status)))
    r.appendChild(el('span', 'arname', a.description))
    const am = a.model === 'inherit' ? t.info?.model : a.model
    if (am) r.appendChild(el('span', 'armodel', modelName(am)))
    const span = agentSpan(a)
    if (span) r.appendChild(el('span', 'artime', span))
    r.title = agentFacts(a)
    r.onclick = () => { panel.hidden = true; openAgent(t.sessionId || t.id, a.id) }
    panel.appendChild(r)
    for (const k of kids(a.id)) line(k, depth + 1)
  }
  for (const a of kids(null)) line(a, 0)
  // an orphan - its parent is not in this session - still has to be reachable
  for (const a of all) {
    if (a.parent && !all.some(x => x.id === a.parent)) line(a, 0)
  }

  fab.onclick = e => {
    e.stopPropagation()
    panel.hidden = !panel.hidden
    fab.classList.toggle('on', !panel.hidden)
    if (!panel.hidden) {
      dismissOn(panel, () => { panel.hidden = true; fab.classList.remove('on') })
    }
  }
  stage.append(fab, panel)
}

/**
 * The toolbar for an agent thread. An agent cannot be resumed, forked or
 * renamed, so the only real actions are stepping between siblings, going up to
 * the chat that spawned it, and taking its answer away.
 */
function agentActs (t) {
  const acts = el('div', 'acts')
  const all = t.agents || []
  const at = all.findIndex(a => a.id === t.agentId)
  const mk = (name, tip, fn, off) => {
    const b = el('button', 'btn ico')
    b.appendChild(icon(name))
    b.title = tip
    if (off) b.disabled = true; else b.onclick = fn
    return b
  }
  if (all.length > 1 && at >= 0) {
    const prev = el('button', 'btn ico'); prev.textContent = '‹'
    prev.title = 'Previous agent'
    prev.setAttribute('aria-label', prev.title)
    if (at === 0) prev.disabled = true
    else prev.onclick = () => openAgent(t.sessionId, all[at - 1].id)
    const pos = el('span', 'apos', `${at + 1} of ${all.length}`)
    const next = el('button', 'btn ico'); next.textContent = '›'
    next.title = 'Next agent'
    next.setAttribute('aria-label', next.title)
    if (at === all.length - 1) next.disabled = true
    else next.onclick = () => openAgent(t.sessionId, all[at + 1].id)
    acts.append(prev, pos, next)
  }
  acts.append(
    mk('message', 'Open the chat that launched this agent',
      () => send({ type: 'session', id: t.sessionId })),
    mk('reload', 'Reload this thread', () => openAgent(t.sessionId, t.agentId)),
    mk('copy', 'Copy what this agent reported back',
      () => send({ type: 'copy', text: t.result || '', label: 'Agent result copied' }),
      !t.result))
  return acts
}

/**
 * Draw a chat's blocks into the message list, starting at block `from`, which
 * must be the start of a run - the copy button and the "Claude · time" line at
 * the end of a run carry the text of the whole run. Each node is tagged with its
 * block index so a live update can replace just the tail.
 */
function renderBlocks (t, blocks, from, body, to = blocks.length, before = null) {
  let run = []                        // the text of the message being built up
  // older messages drawn later are slotted in above what is already there
  const add = n => before ? body.insertBefore(n, before) : body.appendChild(n)
  blocks.forEach((turn, bi) => {
    if (bi < from || bi >= to) return
    const next = blocks[bi + 1]
    if (turn.role === 'note') {
      const n = noteCard(turn)
      n.dataset.bi = bi
      add(n)
      return
    }
    const w = el('div', 'msg ' + turn.role + (turn.text ? '' : ' worked'))
    if (turn.text) {
      const b = el('div', 'bubble')
      b.dataset.src = turn.text          // kept so find can re-render cleanly
      b.innerHTML = window.md(turn.text)
      addCopyButtons(b)
      w.appendChild(b)
      run.push(turn.text)
    }
    if (turn.images && turn.images.length) {
      const iw = el('div', 'imgs')
      for (const im of turn.images) {
        const fig = el('div', 'shot loading')
        const img = el('img')
        img.loading = 'lazy'
        // the bytes arrive only once the picture is actually on screen
        PENDING.set(`${im.ti}:${im.ii}`, { img, fig })
        SEEN.observe(fig)
        fig.dataset.key = `${im.ti}:${im.ii}`
        fig.appendChild(img)
        // opens in an editor tab, where it can be zoomed and kept beside the chat
        // read back from the key: it is renumbered when the whole chat replaces a quick copy
        fig.onclick = () => {
          const [ti, ii] = fig.dataset.key.split(':').map(Number)
          send({ type: 'openImage', id: t.id, path: im.path, ti, ii, part: !!CUR?.part })
        }
        iw.appendChild(fig)
      }
      w.appendChild(iw)
    }
    // an agent gets a card of its own, so it drops out of the "ran N tools" line
    const cards = turn.tools.length ? agentCards(turn.tools, t) : null
    const shown = cards ? turn.tools.filter(x => !x.card) : turn.tools
    if (shown.length) w.appendChild(toolSummary(shown))
    if (cards) w.appendChild(cards)
    if (turn.edits && turn.edits.length) w.appendChild(turnChanges(turn.edits, t.id))
    // one attribution per run, not one per block - and the copy button lives
    // there rather than floating over the text, where it collided with the
    // copy button a code block puts in the same corner
    if (!next || next.role !== turn.role) {
      const when = el('div', 'when')
      const text = run.join('\n\n')
      if (text) when.appendChild(msgCopyButton(text))
      when.appendChild(el('span', 'whot',
        (turn.role === 'user' ? 'You' : 'Claude') + (turn.ts ? ' · ' + clock(turn.ts) : '')))
      w.appendChild(when)
      run = []
    }
    w.dataset.bi = bi
    add(w)
  })
}

// A long chat is drawn from its latest messages; older ones are drawn as you
// scroll up to them. Drawing all 3,000 messages of a long chat up front is what
// made it slow to open.
const FIRST_DRAW = 150   // messages drawn when a chat opens
const MORE_DRAW = 150    // drawn each time you scroll near the top
let SHOWN_FROM = 0       // the oldest block on screen
let ALL_BLOCKS = []

/** Step back to where a run of same-speaker blocks starts, so it is drawn whole. */
function runStart (blocks, i) {
  while (i > 0 && blocks[i - 1].role === blocks[i].role && blocks[i].role !== 'note') i--
  return i
}

/** Draw older messages above what is on screen, keeping the reader in place. */
function drawEarlier (count = MORE_DRAW) {
  const body = $('.msgs')
  if (!body || !CUR || SHOWN_FROM <= 0) return false
  const from = count === Infinity ? 0 : runStart(ALL_BLOCKS, Math.max(0, SHOWN_FROM - count))
  const h = body.scrollHeight, top = body.scrollTop
  renderBlocks(CUR, ALL_BLOCKS, from, body, SHOWN_FROM, body.firstElementChild)
  SHOWN_FROM = from
  body.scrollTop = top + (body.scrollHeight - h)
  return true
}

// the blocks on screen for the open chat, so a live update can tell what is new
let LAST_SIGS = []
// what a block looks like on screen: its size, and the state of any agent it
// launched - a card turning from running to done has to be redrawn too
const blockSig = (b, t) => [b.role, (b.text || '').length, b.tools.length,
  (b.images || []).length, (b.edits || []).length, b.ts || '',
  b.tools.filter(x => x.useId).map(x => {
    const a = (t.agents || []).find(g => g.toolUseId === x.useId)
    return a ? a.status + a.messages : ''
  }).join(',')].join('|')
const sigsOf = (blocks, t) => blocks.map(b => blockSig(b, t))

/**
 * A live update to the chat already on screen. Every write Claude made used to
 * rebuild the whole chat - hundreds of turns of formatting, about once a second -
 * so the view fell behind the terminal and never caught up. Now only what
 * changed is redrawn: from the first block that differs, backed up to the start
 * of its run, to the end. Usually that is the last message or two.
 */
// Whether the open chat is following the conversation: true while you sit at
// the bottom, false once you scroll up to read. Kept as a state rather than
// measured on each update - anything that changes the layout (the footer, the
// header folding) knocked the measurement off and the chat stopped following.
let FOLLOW = true
// Scrolls made here, not by you: they must not fold the header or count as
// you reading upward.
let AUTO_UNTIL = 0
function stickToEnd (body) {
  if (!body || !FOLLOW) return
  AUTO_UNTIL = Date.now() + 200
  body.scrollTop = body.scrollHeight
  // and again once the browser has laid out what was just added
  requestAnimationFrame(() => {
    if (!FOLLOW) return
    AUTO_UNTIL = Date.now() + 200
    body.scrollTop = body.scrollHeight
  })
}

function updateLive (t) {
  const body = $('.msgs')
  if (!body) return false
  const blocks = collapse(t.turns)
  const sigs = sigsOf(blocks, t)
  let k = 0
  while (k < sigs.length && k < LAST_SIGS.length && sigs[k] === LAST_SIGS[k]) k++
  if (k < sigs.length || sigs.length !== LAST_SIGS.length) {
    // back to the start of the run: the block that ended it carried the run's
    // copy line, and if the run grew that line has to move to the new end
    while (k > 0 && blocks[k - 1] && blocks[k] && blocks[k - 1].role === blocks[k].role &&
      blocks[k].role !== 'note') k--
    for (const n of [...body.children]) {
      if (Number(n.dataset.bi) >= k) { releaseImages(n); n.remove() }
    }
    renderBlocks(t, blocks, Math.max(k, SHOWN_FROM), body)
  }
  ALL_BLOCKS = blocks
  LAST_SIGS = sigs
  // the title moves too: a new chat is untitled until Claude names it, and a
  // rename made in the terminal lands here (left alone while you type one)
  const h2 = $('#detail .dtop h2')
  if (h2 && t.title && h2.textContent !== t.title) h2.textContent = t.title
  // and the numbers under it: a chat opened as it started read 0 messages until reopened
  const facts = $('#detail .dhead .facts')
  if (facts) facts.textContent = chatFacts(t)
  CUR = t
  // the footer numbers and the agents button move with every reply
  const d = $('#detail')
  // The footer's numbers are swapped in place rather than the footer replaced:
  // rebuilding it threw away the runner too, so it restarted from the left edge
  // every time Claude wrote a line. The file list keeps its open or closed state.
  const oldFoot = d.querySelector('.foot')
  if (oldFoot) {
    const fresh = footer(t)
    const runner = oldFoot.querySelector('.runstrip')
    const tree = oldFoot.querySelector('.ftree')
    const treeOpen = !!(tree && !tree.hidden)
    fresh.querySelector('.runstrip')?.remove()
    for (const n of [...oldFoot.children]) if (n !== runner) n.remove()
    for (const n of [...fresh.children]) oldFoot.appendChild(n)
    if (treeOpen) {
      const t2 = oldFoot.querySelector('.ftree')
      if (t2) {
        t2.hidden = false
        const c = oldFoot.querySelector('.fchanged .chev2')
        if (c) c.textContent = '▾'
      }
    }
    const busy = isBusy(t.id)
    if (busy && !runner) oldFoot.prepend(runnerStrip())
    if (!busy && runner) runner.remove()
  }
  // The agents list is rebuilt only when an agent starts or finishes, and an
  // open one stays open where it was scrolled: rebuilt with every line Claude
  // wrote, it jumped back to the top about once a second.
  const stage = d.querySelector('.stage')
  if (stage) {
    const sig = (t.agents || []).map(a => a.id + ':' + a.status).join(',')
    const oldFab = stage.querySelector('.afab')
    const oldPanel = stage.querySelector('.apanel')
    const open = !!(oldPanel && !oldPanel.hidden)
    if (!oldFab || oldFab.dataset.sig !== sig || !open) {
      const top = oldPanel ? oldPanel.scrollTop : 0
      stage.querySelectorAll('.afab, .apanel').forEach(n => n.remove())
      agentsFab(t, stage)
      if (open) stage.querySelector('.afab')?.click()
      const p = stage.querySelector('.apanel')
      if (p) p.scrollTop = top
    }
  }
  stickToEnd(body)
  return true
}

function showDetail (t, live) {
  // the whole chat arriving after its quick first copy: drawn afresh, since the
  // copy's messages were numbered from its own start, and held where the reader is
  const fill = !!(live && CUR && CUR.id === t.id && CUR.part && !t.part)
  if (fill && fillInPlace(t)) return
  if (live && !fill && CUR && CUR.id === t.id && !$('#detail').hidden && updateLive(t)) return
  document.querySelectorAll('body > .menu').forEach(m => m.remove())
  // a live append re-renders the chat, so hold the reading position across it
  const msgs = live && $('.msgs')
  const keep = msgs ? msgs.scrollTop : 0
  const keepBottom = msgs ? msgs.scrollHeight - msgs.scrollTop : 0
  const findWas = live ? ($('#find')?.value || '') : ''
  // the header is rebuilt from scratch below, so whether it was folded away has
  // to be carried over - otherwise every message written to a live chat pops the
  // toolbar back open on its own
  const wasSlim = !!(live && $('.dhead')?.classList.contains('slim'))
  CUR = t
  hits = []; hitAt = -1
  SEEN.disconnect()                 // nothing from the old copy stays watched
  PENDING.clear(); ASKED.clear()
  $('#tabs').hidden = TAB === 'chats'   // a chat opened in the background must not take the tab row from another page
  $('#view-chats .bar').hidden = true
  $('#rows').hidden = true

  const d = $('#detail')
  d.hidden = false
  d.innerHTML = ''
  const isAgent = !!t.isAgent

  // ---- sticky header
  const head = el('div', 'dhead')
  const top = el('div', 'dtop')
  const back = el('button', 'iconbtn', '‹')
  // an agent thread belongs to a chat, so back goes there rather than to the list
  back.title = isAgent ? 'Back to the chat' : 'All chats'
  back.onclick = isAgent ? () => send({ type: 'session', id: t.sessionId }) : closeDetail
  const h = el('h2', '', t.title || '(untitled)')
  top.append(back, h)
  const codex = t.provider === 'codex'
  if (codex) top.appendChild(sourceIcon('codex'))
  if (isAgent) {
    if (t.agentType) top.appendChild(el('span', 'atype', t.agentType))
    top.appendChild(el('span', 'astate ' + statusClass(t.status), t.status))
  } else {
    const pen = el('button', 'iconbtn renamepen')
    pen.appendChild(icon('pencil'))
    pen.title = 'Rename chat'
    pen.setAttribute('aria-label', 'Rename chat')
    pen.onclick = () => startRename(h, t)
    top.appendChild(pen)
  }
  // a new chat without leaving this one for the list
  const fresh = el('button', 'iconbtn newinchat')
  fresh.appendChild(icon('plus'))
  fresh.title = 'Start a new Claude session in a terminal'
  fresh.onclick = () => send({ type: 'newChat' })
  top.appendChild(fresh)
  head.appendChild(top)

  head.appendChild(el('div', 'facts', chatFacts(t)))

  const row = SESSIONS.find(x => x.id === t.id)
  if (row?.git?.length) {
    const counts = new Map()
    for (const x of SESSIONS) for (const g of x.git || []) counts.set(g, (counts.get(g) || 0) + 1)
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    // a chip saying "main" on every chat is noise - only show the exception
    const notable = row.git.length > 1 || (common && row.git[0] !== common)
    if (notable) {
      const g = el('div', 'gitrow')
      for (const name of row.git) {
        const chip = el('span', 'gitchip')
        chip.append(icon('fork', 'bico'), el('span', '', name))
        chip.title = row.git.length > 1
          ? 'this chat spans more than one git branch'
          : `most chats are on ${common}; this one is not`
        g.appendChild(chip)
      }
      head.appendChild(g)
    }
  }

  if (row && (row.branchedFrom || row.branches.length)) {
    const line = el('div', 'lineage')
    const jump = (id, label) => {
      const b = el('button', 'blink')
      b.append(icon('fork', 'bico'), el('span', '', label))
      b.onclick = () => { PERF = { id, t0: performance.now() }; send({ type: 'session', id }) }
      line.appendChild(b)
    }
    if (row.branchedFrom) {
      const from = SESSIONS.find(x => x.id === row.branchedFrom)
      jump(row.branchedFrom, `Branched from ${from ? from.title : 'another chat'}`)
    }
    for (const kid of row.branches) {
      const to = SESSIONS.find(x => x.id === kid)
      if (to) jump(kid, `Branch: ${to.title}`)
    }
    if (line.children.length) head.appendChild(line)
  }

  // an agent thread has none of this: it cannot be resumed, forked or renamed
  if (isAgent) head.appendChild(agentActs(t))
  else {
    // ---- one resume button + a dropdown for where
    // one Resume button that honours the chosen target, plus a picker that sets it
    const acts = el('div', 'acts')
    const split = el('div', 'split')
    const run = el('button', 'btn pri')
    run.append(icon('play', 'runico'), el('span', '', 'Resume'))
    run.onclick = () => send({ type: 'resume', id: t.id })
    const caret = el('button', 'btn pri caret')
    caret.hidden = codex          // a codex chat can only go back to a terminal
    // the menu floats at body level: the toolbar clips its own overflow when the
    // header collapses, which was swallowing it whole
    const menu = el('div', 'menu')
    menu.hidden = true
    document.body.appendChild(menu)

    const paint = () => {
      const spec = TARGETS[TARGET] || TARGETS.terminal
      caret.replaceChildren(icon(spec.icon, 'tgtico'), el('span', 'tcaret', '▾'))
      caret.title = `Resume in ${spec.label}`
      run.title = `Resume in ${spec.label}`
      for (const b of menu.children) b.classList.toggle('on', b.dataset.target === TARGET)
    }
    for (const [key, spec] of Object.entries(TARGETS)) {
      const b = el('button', 'menuitem')
      b.dataset.target = key
      b.append(icon(spec.icon, 'mico'), el('span', '', spec.label), el('em', '', spec.hint))
      b.onclick = () => {
        // the picker only chooses where - Resume is what launches
        TARGET = key
        menu.hidden = true
        paint()
        send({ type: 'setTarget', target: key })
      }
      menu.appendChild(b)
    }
    paint()
    caret.onclick = e => {
      e.stopPropagation()
      if (!menu.hidden) { menu.hidden = true; return }
      const b = caret.getBoundingClientRect()
      menu.hidden = false
      const m = menu.getBoundingClientRect()
      menu.style.left = `${Math.min(b.left, window.innerWidth - m.width - 8)}px`
      menu.style.top = `${Math.min(b.bottom + 4, window.innerHeight - m.height - 8)}px`
      const kill = () => {
        menu.hidden = true
        document.removeEventListener('click', kill, true)
        window.removeEventListener('blur', kill)
      }
      setTimeout(() => {
        document.addEventListener('click', kill, true)
        window.addEventListener('blur', kill)
      }, 0)
    }
    split.append(run, caret)

    // the rest are icons - the labels were eating the whole row
    const mk = (name, tip, fn) => {
      const b = el('button', 'btn ico')
      b.appendChild(icon(name))
      b.title = tip
      b.onclick = fn
      return b
    }
    acts.append(split)
    // branching and the handover brief are Claude's own mechanisms - codex has
    // no equivalent, so the buttons would only ever fail
    if (!codex) {
      acts.append(
        mk('fork', 'Branch: a new session carrying this chat\'s full context, like /branch',
          () => send({ type: 'fork', id: t.id })),
        mk('brief', 'Fork with a brief: a fresh session that reads a summary instead of the whole chat',
          () => send({ type: 'forkBrief', id: t.id })))
    }
    acts.append(
      mk('chart', 'Stats for this chat', () => send({ type: 'analytics', id: t.id })),
      mk('reload', 'Reload this chat', () => send({ type: 'session', id: t.id })),
      mk('export', 'Export as Markdown', () => send({ type: 'export', id: t.id })),
      // a command headed for a shell carries only an id that is plainly an id
      ...(/^[\w-]+$/.test(t.id) ? [mk('copy', 'Copy the command to resume this in a terminal',
        () => send({ type: 'copy',
          text: codex ? `codex resume ${t.id}` : `claude --resume ${t.id}`,
          label: 'Resume command copied' }))] : []))
    head.appendChild(acts)
  }

  // ---- in-chat search
  const find = el('div', 'find')
  const fi = el('input'); fi.type = 'search'; fi.placeholder = 'Find in this chat…'; fi.id = 'find'
  const cnt = el('span', 'cnt', '')
  // Enter walks the matches, Shift+Enter goes back - no arrow buttons needed
  fi.oninput = () => runFind(fi.value, cnt)
  fi.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) } }

  // one switch for every "Ran N commands" block in the chat
  const foldAll = el('button', 'iconbtn foldall')
  const paintFold = () => {
    foldAll.replaceChildren(icon(ALLTOOLS ? 'collapse' : 'expand'))
    foldAll.title = ALLTOOLS ? 'Collapse every tool section' : 'Expand every tool section'
  }
  foldAll.onclick = () => {
    ALLTOOLS = !ALLTOOLS
    for (const w of d.querySelectorAll('.twork')) {
      w.querySelector('.tdetail').hidden = !ALLTOOLS
      w.querySelector('.chev2').textContent = ALLTOOLS ? '⌄' : '›'
    }
    paintFold()
  }
  paintFold()
  find.append(fi, cnt, foldAll)
  head.appendChild(find)
  d.appendChild(head)

  // ---- messages
  const body = el('div', 'msgs')
  // The header gives its room back as you read: scrolling down leaves the title
  // row, scrolling up brings the toolbar and find box back.
  const jump = el('button', 'tobottom')
  jump.appendChild(icon('chevron', 'jumpico'))
  jump.title = 'Jump to the latest message'
  jump.hidden = true
  jump.onclick = () => { FOLLOW = true; body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }) }

  let lastY = keep, settling = 0
  const slim = on => {
    if (head.classList.contains('slim') === on) return
    head.classList.toggle('slim', on)
    // Collapsing changes the header's height, which moves scrollTop under us and
    // would read as a scroll in the opposite direction. Ignore that echo.
    settling = Date.now() + 260
  }
  body.onscroll = () => {
    const y = body.scrollTop
    if (y < 600 && SHOWN_FROM > 0) { drawEarlier(); return }
    const fromEnd = body.scrollHeight - y - body.clientHeight
    jump.hidden = fromEnd < 120
    // our own scrolls, and the header settling, say nothing about what you did
    if (Date.now() < settling || Date.now() < AUTO_UNTIL) { lastY = y; return }
    FOLLOW = fromEnd < 80
    // while you are pointing at the header it stays open, whatever the
    // scroll does underneath - a trackpad's coasting used to fold it away
    if (onHead) { lastY = y; return }
    if (y < 24) { slim(false); lastY = y; return }
    // asymmetric on purpose - it should be easier to bring the toolbar back than
    // to fold it away - but not so small that momentum jitter flips it
    if (y > lastY + 10) slim(true)
    else if (y < lastY - 12) slim(false)
    lastY = y
  }
  // reaching for the header brings it back and it stays - only scrolling
  // down again folds it away
  // it settles like any other fold, so the room it takes back is not read as a
  // scroll that folds it away again - and a reader at the bottom stays there
  let onHead = false
  head.onmouseenter = () => { onHead = true; slim(false); stickToEnd(body) }
  head.onmouseleave = () => { onHead = false; lastY = body.scrollTop }
  if (wasSlim) { head.classList.add('slim'); settling = Date.now() + 260 }
  const blocks = collapse(t.turns)
  // a live redraw keeps whatever older messages were already drawn
  const wasFrom = fill ? Math.max(0, blocks.length - (ALL_BLOCKS.length - SHOWN_FROM))
    : live && ALL_BLOCKS.length ? SHOWN_FROM : Infinity
  ALL_BLOCKS = blocks
  SHOWN_FROM = Math.min(wasFrom, runStart(blocks, Math.max(0, blocks.length - FIRST_DRAW)))
  renderBlocks(t, blocks, SHOWN_FROM, body)
  LAST_SIGS = sigsOf(blocks, t)
  const stage = el('div', 'stage')     // holds the messages and the floating button
  stage.append(body, jump)
  agentsFab(t, stage)
  d.appendChild(stage)

  tips(d)                                // the chat toolbar
  d.appendChild(footer(t))

  if (live) {
    // put the reader back: pinned to the end if that is where they were
    requestAnimationFrame(() => {
      const box = $('.msgs')
      if (!box) return
      if (FOLLOW) stickToEnd(box)
      else box.scrollTop = fill ? box.scrollHeight - keepBottom : keep
      if (findWas) { fi.value = findWas; runFind(findWas, cnt) }
    })
    return
  }

  // a chat opens following its latest message, unless it opened on a match
  FOLLOW = !JUMP
  if (JUMP) {
    const q = JUMP; JUMP = ''
    fi.value = q
    const p = PERF
    requestAnimationFrame(() => {
      const a = performance.now(); runFind(q, cnt)
      if (p) p.find = performance.now() - a
    })
    return
  }

  // open at the end of the conversation, where you left off
  requestAnimationFrame(() => stickToEnd(body))
}

// Tools grouped into plain English: "Ran 2 commands · Edited 1 file", not "Bash ×2".
const VERBS = {
  Bash: ['Ran', 'command', 'commands'],
  Read: ['Read', 'file', 'files'],
  Edit: ['Edited', 'file', 'files'],
  Write: ['Wrote', 'file', 'files'],
  NotebookEdit: ['Edited', 'notebook', 'notebooks'],
  Grep: ['Searched', 'pattern', 'patterns'],
  Glob: ['Matched', 'pattern', 'patterns'],
  WebFetch: ['Fetched', 'page', 'pages'],
  WebSearch: ['Searched the web', '', ''],
  Task: ['Ran', 'sub-agent', 'sub-agents'],
  TodoWrite: ['Updated the plan', '', ''],
}

function phraseFor (name, n) {
  const v = VERBS[name]
  if (v) return v[1] ? `${v[0]} ${n} ${n === 1 ? v[1] : v[2]}` : v[0]
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name)
  const label = mcp ? `${mcp[1]} ${mcp[2].replace(/_/g, ' ')}` : name
  return n > 1 ? `Used ${label} ${n}×` : `Used ${label}`
}

/** Merge Edit/Write into one "Edited N files" line, since that is how it reads. */
function toolSummary (tools) {
  const order = [], counts = new Map()
  for (const t of tools) {
    const key = t.name === 'Write' ? 'Edit' : t.name
    if (!counts.has(key)) { counts.set(key, []); order.push(key) }
    counts.get(key).push(t)
  }
  const wrap = el('div', 'twork')
  const head = el('div', 'thead2')
  head.append(el('span', 'tsum',
    order.map(k => phraseFor(k, counts.get(k).length)).join(' · ')),
    el('span', 'chev2', ALLTOOLS ? '⌄' : '›'))

  const body = el('div', 'tdetail')
  body.hidden = !ALLTOOLS
  for (const t of tools) {
    // each call is a card: what ran, then the command or path it ran on
    const card = el('div', 'tcard')
    const head = el('div', 'tcardhead')
    head.append(icon(t.name === 'Bash' ? 'terminal' : 'pencil', 'tcardico'),
      el('b', '', t.name))
    card.appendChild(head)
    if (t.detail) {
      const pre = el('pre', 'tcode')
      pre.textContent = t.detail
      card.appendChild(pre)
      const cp = el('button', 'codecopy')
      cp.appendChild(icon('copy'))
      cp.title = 'Copy'
      cp.onclick = e => {
        e.stopPropagation()
        send({ type: 'copy', text: t.detail, label: 'Copied' })
      }
      card.appendChild(cp)
    }
    body.appendChild(card)
  }
  head.onclick = () => {
    body.hidden = !body.hidden
    head.querySelector('.chev2').textContent = body.hidden ? '›' : '⌄'
  }
  wrap.append(head, body)
  return wrap
}

/** What this turn changed, as a card under the message - one row per file. */
function turnChanges (edits, id) {
  // several edits to one file in a single turn read better merged
  const byFile = new Map()
  for (const e of edits) {
    const f = byFile.get(e.path) || { ...e, adds: 0, dels: 0, parts: [] }
    f.adds += e.adds; f.dels += e.dels; f.parts.push(e)
    byFile.set(e.path, f)
  }
  const files = [...byFile.values()]
  const adds = files.reduce((n, f) => n + f.adds, 0)
  const dels = files.reduce((n, f) => n + f.dels, 0)

  const card = el('div', 'tchange')
  const head = el('div', 'thead')
  head.append(el('b', '', 'Turn changes'),
    el('span', 'tcount', `${files.length} file${files.length === 1 ? '' : 's'}`),
    el('span', 'adds', `+${adds}`))
  if (dels) head.appendChild(el('span', 'dels', `-${dels}`))
  card.appendChild(head)

  for (const f of files) {
    const row = el('div', 'trow')
    const dir = f.path.replace(/\/[^/]+$/, '').split('/').slice(-2).join('/')
    row.append(icon('pencil', 'tico'),
      el('span', 'tdir', '…/' + dir + '/'), el('span', 'tfile', f.path.split('/').pop()),
      el('span', 'adds', `+${f.adds}`))
    if (f.dels) row.appendChild(el('span', 'dels', `-${f.dels}`))

    const btn = (name, tip, fn) => {
      const b = el('button', 'ract')
      b.appendChild(icon(name)); b.title = tip
      b.onclick = ev => { ev.stopPropagation(); fn() }
      return b
    }
    const acts = el('div', 'tacts')
    acts.append(
      btn('split', f.parts.length > 1 ? `Show the first of ${f.parts.length} edits` : 'Show what changed',
        () => send({ type: 'diff', id, ti: f.parts[0].ti, ei: f.parts[0].ei, part: !!CUR?.part })),
      btn('open', 'Open the file', () => send({ type: 'openFile', path: f.path })),
      btn('copy', 'Copy the path',
        () => send({ type: 'copy', text: f.path, label: 'Path copied' })))
    row.appendChild(acts)
    row.title = f.path
    row.onclick = () => send({ type: 'diff', id, ti: f.parts[0].ti, ei: f.parts[0].ei, part: !!CUR?.part })
    card.appendChild(row)
  }
  return card
}

/**
 * Put a copy button on every fenced block. The button lives outside the <pre>, so
 * selecting the code never picks up the word "Copy".
 */
/**
 * Copy a whole message, as the markdown it was written in rather than the
 * rendered text - blank lines and ** survive, so Slack and Linear format it
 * instead of showing a wall of text.
 */
function msgCopyButton (text) {
  const cp = el('button', 'msgcopy')
  cp.appendChild(icon('copy'))
  cp.title = 'Copy this message'
  cp.onclick = e => {
    e.stopPropagation()
    // both flavours, so Slack keeps the bold and the paragraph gaps
    if (!copyRich(text, flatHtml(window.md(text)))) {
      send({ type: 'copy', text, label: 'Message copied' })
    }
    cp.classList.add('done')
    setTimeout(() => cp.classList.remove('done'), 1200)
  }
  return cp
}

function addCopyButtons (root) {
  for (const pre of root.querySelectorAll('pre.code')) {
    if (pre.parentElement?.classList.contains('codewrap')) continue
    const wrap = el('div', 'codewrap')
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(pre)
    const b = el('button', 'codecopy')
    b.appendChild(icon('copy'))
    b.title = 'Copy code'
    b.onclick = e => {
      e.stopPropagation()
      send({ type: 'copy', text: pre.textContent, label: 'Code copied' })
      b.classList.add('done')
      setTimeout(() => b.classList.remove('done'), 1200)
    }
    wrap.appendChild(b)
  }
}

/** Claude's own markers in a transcript: a recap, or a compaction boundary. */
function noteCard (n) {
  const card = el('div', 'note-card ' + n.kind)
  const head = el('div', 'nhead')
  const KINDS = {
    recap: ['history', 'RECAP'],
    compact: ['compact', 'COMPACTED'],
    agent: ['agent', 'AGENT FINISHED'],
    peer: ['message', 'FROM ANOTHER SESSION'],
  }
  const [ico, label] = KINDS[n.kind] || KINDS.compact
  head.append(icon(ico, 'nico'), el('b', '', label))
  if (n.ts) head.appendChild(el('span', '', clock(n.ts)))
  card.appendChild(head)
  const body = el('div', 'nbody')
  body.innerHTML = window.md(n.text)
  addCopyButtons(body)
  card.appendChild(body)
  // an agent's full report, when the notification carried one - folded, since
  // it is often longer than everything around it
  if (n.detail) {
    const tog = el('button', 'afoldhead')
    tog.append(el('span', 'chev2', '›'), el('span', '', 'What it reported'))
    const rep = el('div', 'afoldbody')
    rep.innerHTML = window.md(n.detail)
    addCopyButtons(rep)
    rep.hidden = true
    tog.onclick = () => {
      rep.hidden = !rep.hidden
      tog.querySelector('.chev2').textContent = rep.hidden ? '›' : '⌄'
    }
    card.append(tog, rep)
  }
  return card
}

/**
 * The row menu, the way a messaging app does it: every action in one place,
 * with groups as a submenu. Right-click a chat, or use the ⋯ button on hover.
 */
function rowMenu (s, x, y) {
  document.querySelector('.ctx')?.remove()
  const menu = el('div', 'ctx')
  let closeSub = () => {}

  const item = (label, fn, opts = {}) => {
    const b = el('button', 'ctxitem' + (opts.danger ? ' danger' : ''))
    b.append(icon(opts.icon || 'sparkle', 'cico'), el('span', '', label))
    if (opts.sub) b.appendChild(el('em', 'arrow', '›'))
    b.onclick = e => { e.stopPropagation(); if (!opts.sub) menu.remove(); fn && fn() }
    // moving onto any other item closes the submenu straight away
    if (!opts.sub) b.onmouseenter = () => closeSub()
    menu.appendChild(b)
    return b
  }
  const sep = () => menu.appendChild(el('div', 'ctxsep'))

  item('Open chat', () => { (PERF = { id: s.id, t0: performance.now() }, send({ type: 'session', id: s.id })) },
    { icon: 'message' })
  item('Resume', () => send({ type: 'resume', id: s.id }), { icon: 'play' })

  // a chat can be put anywhere in the editor, like a window manager places
  // windows - one that is not open yet is resumed into that spot
  let moveSub = null
  {
    const PLACES = [['right-half', 'Right half'], ['right-third', 'Right third'],
      ['right-two-thirds', 'Right two thirds'], ['left-half', 'Left half'],
      ['left-third', 'Left third'], ['bottom-half', 'Bottom half'],
      ['bottom-third', 'Bottom third'], ['top-half', 'Top half'],
      ['full', 'Full editor'], null,
      ['panel', 'Panel at the bottom'], ['panel-right', 'Panel on the right'],
      ['beside', 'Beside a chat in the panel']]
    const moveTo = item(s.live ? 'Move to' : 'Open in', null, { icon: 'layout', sub: true })
    moveSub = el('div', 'ctx sub')
    moveSub.hidden = true
    for (const place of PLACES) {
      // the editor's spots, then the panel's
      if (!place) { moveSub.appendChild(el('div', 'ctxsep')); continue }
      const [pos, label] = place
      const b = el('button', 'ctxitem')
      b.append(el('span', 'tick', ''), el('span', '', label))
      b.onclick = e => { e.stopPropagation(); send({ type: 'moveChat', id: s.id, pos }); menu.remove() }
      moveSub.appendChild(b)
    }
    moveTo.onmouseenter = () => {
      closeSub()
      moveSub.hidden = false
      const r = moveTo.getBoundingClientRect()
      moveSub.style.top = `${Math.max(4, Math.min(r.top, window.innerHeight - 10 - PLACES.length * 28))}px`
      moveSub.style.left = `${Math.min(window.innerWidth - 190, r.right + 2)}px`
    }
    menu.appendChild(moveSub)
  }
  item('Rename…', () => renamePrompt(s), { icon: 'pencil' })
  item('Branch with a brief…', () => send({ type: 'forkBrief', id: s.id }), { icon: 'brief' })
  sep()
  item(s.pinned ? 'Unpin' : 'Pin',
    () => send({ type: 'pin', id: s.id }), { icon: 'pin' })

  // groups, as a submenu that opens beside the row
  const names = [...new Set([...GROUPS, ...SESSIONS.map(x => x.group).filter(Boolean)])].sort()
  const addTo = item(s.group ? 'Change group' : 'Add to group', null, { icon: 'folder', sub: true })
  const sub = el('div', 'ctx sub')
  sub.hidden = true
  for (const name of names) {
    const on = s.group === name
    const b = el('button', 'ctxitem' + (on ? ' picked' : ''))
    // a tick marks the group it is in; choosing it again takes it out
    const tick = el('span', 'tick')
    if (on) tick.appendChild(icon('check'))
    b.append(tick, el('span', '', name))
    b.setAttribute('aria-pressed', String(on))
    b.onclick = e => {
      e.stopPropagation()
      send({ type: 'group', id: s.id, assign: on ? null : name })
      menu.remove()
    }
    sub.appendChild(b)
  }
  sub.appendChild(el('div', 'ctxsep'))
  const mk = el('button', 'ctxitem new')
  mk.append(el('span', '', '+  New group'))
  mk.onclick = e => {
    e.stopPropagation()
    send({ type: 'group', id: s.id, create: true, ask: true })
    menu.remove()
  }
  sub.appendChild(mk)
  closeSub = () => { sub.hidden = true; if (moveSub) moveSub.hidden = true }
  addTo.onmouseenter = () => {
    if (moveSub) moveSub.hidden = true
    sub.hidden = false
    const b = addTo.getBoundingClientRect()
    sub.style.top = `${b.top}px`
    sub.style.left = `${Math.min(window.innerWidth - 190, b.right + 2)}px`
  }
  menu.onmouseleave = () => { sub.hidden = true; if (moveSub) moveSub.hidden = true }
  menu.appendChild(sub)

  sep()
  item(s.archived ? 'Unarchive' : 'Archive chat', () => send({ type: 'archive', id: s.id }),
    { icon: 'archive' })
  if (/^[\w-]+$/.test(s.id)) {
    item('Copy resume command',
      () => send({ type: 'copy', text: s.provider === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`,
        label: 'Resume command copied' }),
      { icon: 'copy' })
  }
  item('Reveal folder', () => send({ type: 'openFolder', path: s.cwd }), { icon: 'open' })
  sep()
  item('Delete chat…', () => send({ type: 'trash', id: s.id }), { icon: 'trash', danger: true })

  document.body.appendChild(menu)
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`
  dismissOn(menu)
}

/** Rename inline, without leaving the list. */
function renamePrompt (s) {
  const row = document.querySelector(`[data-id="${CSS.escape(s.id)}"]`)
  const label = row?.querySelector('.t')
  if (!label) return
  RENAMING = s.id
  const input = el('input', 'rowrename')
  input.value = s.title === '(untitled)' ? '' : s.title
  label.replaceWith(input)
  // the menu's click-away listener is still pending, so focus after it has run
  requestAnimationFrame(() => { input.focus(); input.select() })

  let settled = false
  const done = ok => {
    if (settled) return
    settled = true
    const v = input.value.trim()
    RENAMING = null
    // show the new name at once: the list's own refresh holds while the pointer
    // is over it, so waiting for it left the field sitting there as if unsaved
    if (ok && v && v !== s.title) {
      send({ type: 'rename', id: s.id, title: v })
      const row = SESSIONS.find(x => x.id === s.id)
      if (row) row.title = v
      s.title = v
    }
    renderList()
  }
  input.onkeydown = e => {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); done(true) }
    if (e.key === 'Escape') { e.preventDefault(); done(false) }
  }
  input.onblur = () => done(true)
  input.onclick = e => e.stopPropagation()
}

/** Everything about one chat, as an overlay panel. */
function showAnalytics (a) {
  if (!a) return
  document.querySelector('.sheet')?.remove()
  const sheet = el('div', 'sheet')
  const box = el('div', 'sheetbox')
  const head = el('div', 'sheethead')
  head.append(el('b', '', a.title || '(untitled)'))
  const x = el('button', 'iconbtn')
  x.appendChild(icon('close'))
  x.title = 'Close'
  x.setAttribute('aria-label', 'Close')
  x.onclick = () => sheet.remove()
  head.appendChild(x)
  box.appendChild(head)

  const grid = el('div', 'dgrid')
  const tile = (v, k) => {
    const t = el('div', 'dtile')
    t.append(el('b', '', String(v)), el('span', '', k.toUpperCase()))
    grid.appendChild(t)
  }
  tile(a.turns, 'your turns'); tile(a.messages, 'messages'); tile(nfmt(a.tokens), 'tokens')
  tile(money(a.cost), 'cost'); tile(a.edits, 'file edits'); tile(dur(a.activeMs), 'active')
  box.appendChild(grid)

  box.appendChild(el('p', 'dnote',
    `Started ${clock(a.firstTs)}, last touched ${clock(a.lastTs)}, over ${a.days.length} day${a.days.length === 1 ? '' : 's'}. ` +
    `Began from ${a.entrypoint || 'an unknown surface'}. ` +
    `You wrote ${nfmt(a.userChars)} characters, Claude wrote ${nfmt(a.claudeChars)}.`))

  if (a.days.length > 1) {
    box.appendChild(sheetHead('Across days'))
    const peak = Math.max(...a.days.map(d => d.tokens), 1)
    const row = el('div', 'ddays')
    for (const d of a.days) {
      const cell = el('div', 'dday')
      const b = el('div', 'dbox')
      if (d.tokens) {
        const f = el('i')
        f.style.height = `${Math.max(4, d.tokens / peak * 100)}%`
        b.appendChild(f)
      }
      cell.append(b, el('span', '', d.day.slice(5)))
      cell.title = `${d.day} · ${nfmt(d.tokens)} tokens · ${money(d.cost)}`
      row.appendChild(cell)
    }
    box.appendChild(row)
  }

  if (a.tools.length) {
    box.appendChild(sheetHead('Tools used'))
    const tpeak = Math.max(...a.tools.map(t => t.n), 1)
    for (const t of a.tools.slice(0, 10)) {
      const r = el('div', 'dmodel')
      const top = el('div', 'dmtop')
      top.append(el('b', '', t.name), el('span', '', `${t.n}×`))
      const bar = el('div', 'dmbar')
      const f = el('i')
      f.style.width = `${t.n / tpeak * 100}%`
      bar.appendChild(f)
      r.append(top, bar)
      box.appendChild(r)
    }
  }

  if (a.info?.files?.length) {
    box.appendChild(sheetHead(`Files touched · ${a.info.files.length}`))
    for (const f of a.info.files.slice(0, 12)) {
      const r = el('div', 'frowf')
      r.append(el('span', 'fname', f.path.split('/').pop()),
        el('span', 'fdir', f.path.replace(/\/[^/]+$/, '')),
        el('span', 'adds', `+${f.adds}`), el('span', 'dels', `-${f.dels}`))
      r.onclick = () => send({ type: 'openFile', path: f.path })
      box.appendChild(r)
    }
  }

  sheet.appendChild(box)
  sheet.onclick = e => { if (e.target === sheet) sheet.remove() }
  document.body.appendChild(sheet)
}

function sheetHead (t) {
  const h = el('div', 'dhead3')
  h.appendChild(el('span', '', t.toUpperCase()))
  return h
}

/** The bar pinned under a chat: context, cache, cost, turns, and what it changed. */
// ---------------------------------------------------------------- the runner
// Shown across the top of a chat's footer while Claude is working in it. Our own
// character - a notebook on legs, for Agent Logbook - drawn as pixel art in the
// clay palette, two frames swapped as it runs. Deliberately not Anthropic's
// Clawd: this ships publicly, and their mascot is theirs.
function runnerSprite () {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 15 15')
  svg.setAttribute('class', 'runsprite')
  svg.setAttribute('shape-rendering', 'crispEdges')
  const px = (g, x, y, w, h, fill) => {
    const r = document.createElementNS(ns, 'rect')
    r.setAttribute('x', x); r.setAttribute('y', y)
    r.setAttribute('width', w); r.setAttribute('height', h)
    r.setAttribute('fill', fill)
    g.appendChild(r)
  }
  // a spiral-bound notebook with a bookmark, so it reads as a logbook at a glance
  const C = '#d97757', D = '#b85f42', P = '#f6e3d3', K = '#2a1d17', W = '#ffffff'
  const body = document.createElementNS(ns, 'g')
  px(body, 3, 1, 10, 10, C)                  // cover
  px(body, 12, 2, 1, 8, P)                   // page edges
  for (const y of [2, 4, 6, 8]) px(body, 2, y, 2, 1, K)   // spiral binding
  px(body, 5, 2, 6, 2, '#f1c9a8')            // cover label
  px(body, 6, 3, 4, 1, D)                    // its title line
  px(body, 6, 5, 1, 2, K); px(body, 9, 5, 1, 2, K)        // eyes
  px(body, 6, 5, 1, 1, W); px(body, 9, 5, 1, 1, W)
  px(body, 7, 8, 2, 1, K)                    // mouth
  px(body, 10, 0, 1, 3, '#7fb069')           // bookmark ribbon
  px(body, 0, 6, 2, 1, D); px(body, 13, 7, 2, 1, D)       // arms
  svg.appendChild(body)
  // two leg poses, alternated by the stylesheet
  const a = document.createElementNS(ns, 'g'); a.setAttribute('class', 'legs a')
  px(a, 5, 11, 1, 2, D); px(a, 4, 13, 2, 1, K)
  px(a, 10, 11, 1, 1, D); px(a, 10, 12, 2, 1, K)
  const b = document.createElementNS(ns, 'g'); b.setAttribute('class', 'legs b')
  px(b, 6, 11, 1, 1, D); px(b, 6, 12, 2, 1, K)
  px(b, 9, 11, 1, 2, D); px(b, 8, 13, 2, 1, K)
  svg.append(a, b)
  return svg
}

/** The working strip for a chat: present while Claude is busy in it, gone otherwise. */
const RUN_MS = 7000                // one crossing; must match the stylesheet

function runnerStrip () {
  const strip = el('div', 'runstrip')
  const track = el('div', 'runtrack')
  const who = el('div', 'runner')
  // it walks there and back rather than wrapping to the left edge, so a jump
  // back to the start can never be mistaken for a restart
  const face = el('div', 'runface')
  face.appendChild(runnerSprite())
  who.appendChild(face)
  // Its position follows one clock shared by every runner ever drawn, so a
  // runner that is redrawn - when a reply lands, when the live state is
  // repainted - carries on from where it was instead of starting over.
  who.style.animationDelay = `-${Date.now() % (RUN_MS * 2)}ms`
  face.style.animationDelay = who.style.animationDelay
  track.appendChild(who)
  strip.append(track, el('span', 'runlabel', 'Claude is working'))
  return strip
}

const isBusy = id => SESSIONS.find(x => x.id === id)?.live === 'busy'

/** Show or hide the runner on the chat that is open, as its state changes. */
function paintRunner () {
  const foot = $('#detail .foot')
  if (!foot || !CUR) return
  const busy = isBusy(CUR.id)
  const strip = foot.querySelector('.runstrip')
  if (busy && !strip) foot.prepend(runnerStrip())
  if (!busy && strip) strip.remove()
}

// When the footer is too narrow for both groups on one line, the second group
// wraps under the first. Then drop the divider and give the labels one width,
// so the two rows line up instead of the second starting indented.
const STACK = new ResizeObserver(es => { for (const e of es) restack(e.target) })
function restack (f) {
  const groups = [...f.querySelectorAll('.fgroup')].filter(g => !g.hidden)
  const labels = [...f.querySelectorAll('.fglabel')]
  f.classList.remove('stacked')
  labels.forEach(l => { l.style.minWidth = '' })
  if (groups.length < 2 || groups[1].offsetTop <= groups[0].offsetTop) return
  f.classList.add('stacked')
  const w = Math.max(...labels.map(l => l.getBoundingClientRect().width))
  labels.forEach(l => { l.style.minWidth = `${Math.ceil(w)}px` })
}
let STACKED = null   // only the footer on screen is watched, so old ones can be freed
function watchStack (f) {
  if (STACKED) STACK.unobserve(STACKED)
  STACKED = f
  STACK.observe(f)
  restack(f)
}

function footer (t) {
  const i = t.info || { series: [], files: [] }
  const bar = el('div', 'foot')
  if (isBusy(t.id)) bar.appendChild(runnerStrip())

  const top = el('div', 'fmeta')
  const spark = contextLine(i)
  spark.title = 'Open the analytics for this chat'
  spark.onclick = () => send({ type: 'analytics', id: t.id })
  top.appendChild(spark)
  const pct = i.window ? Math.round(i.context / i.window * 100) : 0
  const facts = el('div', 'fnums')
  const row2 = SESSIONS.find(x => x.id === t.id)
  // two labelled groups rather than one long run: what the conversation uses
  // of Claude, and - while it runs - what it uses of this laptop
  const group = label => {
    const g = el('div', 'fgroup')
    g.appendChild(el('span', 'fglabel', label))
    facts.appendChild(g)
    return g
  }
  const claude = group('Claude')
  claude.append(
    stat(`${nfmt(i.context)} / ${nfmt(i.window)}`, `context at the last message · ${pct}% of the window`,
      pct >= 90 ? 'hot' : ''),
    stat(`Cache ${i.cachePct}%`, 'share of input tokens served from cache'),
    stat(money(t.cost), 'cost at API list prices'))
  // the branch only when it says something: nearly every chat is on the same one
  if (row2?.git?.length) {
    const counts = new Map()
    for (const x of SESSIONS) for (const g of x.git || []) counts.set(g, (counts.get(g) || 0) + 1)
    const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (row2.git.length > 1 || (common && row2.git[0] !== common)) {
      claude.appendChild(stat(row2.git.join(', '),
        row2.git.length > 1 ? 'git branches this chat touched' : `git branch this chat ran on - most chats are on ${common}`))
    }
  }
  // what this chat is costing the laptop, shown while it runs
  const laptop = group('Laptop')
  laptop.classList.add('resgroup')
  const rs = stat('', 'How much of your laptop this chat is using right now: memory (RAM) and processor (CPU), counting Claude and every command it has started')
  rs.classList.add('resstat')
  laptop.appendChild(rs)
  const rnow = RES?.sessions?.[t.sessionId || t.id]
  laptop.hidden = !rnow
  if (rnow) { rs.textContent = resText(rnow); rs.classList.toggle('hot', heavy(rnow)) }
  top.appendChild(facts)
  bar.appendChild(top)
  watchStack(facts)

  if (i.files.length) {
    const head = el('div', 'fchanged')
    const caret = el('span', 'chev2', '▸')
    head.append(caret,
      el('b', '', `${i.files.length} file${i.files.length === 1 ? '' : 's'} changed`),
      el('span', 'adds', `+${i.adds.toLocaleString()}`),
      el('span', 'dels', `-${i.dels.toLocaleString()}`))
    const list = el('div', 'ftree')
    list.hidden = true
    for (const f of i.files) {
      const row = el('div', 'frowf')
      row.append(el('span', 'fname', f.path.split('/').pop()),
        el('span', 'fdir', f.path.replace(/\/[^/]+$/, '').replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/')),
        el('span', 'adds', `+${f.adds}`), el('span', 'dels', `-${f.dels}`),
        el('span', 'fedits', `${f.edits}×`))
      row.title = f.path
      row.onclick = () => send({ type: 'openFile', path: f.path })
      list.appendChild(row)
    }
    head.onclick = () => { list.hidden = !list.hidden; caret.textContent = list.hidden ? '▸' : '▾' }
    bar.append(head, list)
  }
  return bar
}

/** Context growth across the conversation, drawn as a filled sparkline. */
function contextLine (i) {
  const wrap = el('div', 'spark2')
  const pts = i.series || []
  if (pts.length < 2) return wrap
  const W = 120, H = 30, peak = Math.max(...pts, 1)
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  const xy = pts.map((v, n) => [n / (pts.length - 1) * W, H - (v / peak) * (H - 2) - 1])
  const line = xy.map(([x, y], n) => `${n ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('')
  const fill = document.createElementNS(ns, 'path')
  fill.setAttribute('d', `${line}L${W} ${H}L0 ${H}Z`)
  fill.setAttribute('class', 'sfill')
  const stroke = document.createElementNS(ns, 'path')
  stroke.setAttribute('d', line)
  stroke.setAttribute('class', 'sline')
  svg.append(fill, stroke)
  svg.setAttribute('title', `context over ${pts.length} replies, peak ${nfmt(peak)}`)
  wrap.appendChild(svg)
  return wrap
}

function stat (text, tip, cls) {
  const s = el('span', 'fstat ' + (cls || ''), text)
  s.title = tip
  return s
}

function startRename (h, t) {
  const input = el('input', 'rename')
  input.value = t.title || ''
  h.replaceWith(input)
  input.focus(); input.select()
  // Esc swaps the field out, which blurs it, which used to finish a second time
  // - and that second pass re-wired the wrong button, so rename went dead
  let done = false
  const finish = ok => {
    if (done) return
    done = true
    const name = input.value.trim()
    const h2 = el('h2', '', ok && name ? name : (t.title || '(untitled)'))
    const row = input.parentElement
    input.replaceWith(h2)
    const pen = row?.querySelector('.renamepen')
    if (pen) pen.onclick = () => startRename(h2, t)
    if (ok && name && name !== t.title) { t.title = name; send({ type: 'rename', id: t.id, title: name }) }
  }
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  }
  input.onblur = () => finish(true)
}

// ---------------------------------------------------------------- find in chat
function runFind (q, cnt) {
  const body = $('.msgs')
  if (!body) return
  if (q) drawEarlier(Infinity)        // a match can be anywhere in the chat
  hits = []; hitAt = -1
  const ql = q.toLowerCase()
  for (const b of body.querySelectorAll('.bubble')) {
    // only touch a message that has marks to clear or the phrase to mark -
    // redrawing every message of a long chat took most of a second
    const want = !!q && (b.dataset.src || '').toLowerCase().includes(ql)
    if (!want && !b.querySelector('mark')) continue
    b.innerHTML = window.md(b.dataset.src || '')   // reset any previous marks
    addCopyButtons(b)
    if (!want) continue
    // walk text nodes so highlighting never disturbs the rendered markup
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
    const targets = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.toLowerCase().includes(ql)) targets.push(n)
    }
    for (const n of targets) {
      const frag = document.createDocumentFragment()
      let last = 0
      const re = new RegExp(rx(q), 'gi')
      let m
      while ((m = re.exec(n.nodeValue))) {
        frag.appendChild(document.createTextNode(n.nodeValue.slice(last, m.index)))
        const mark = document.createElement('mark')
        mark.textContent = m[0]
        frag.appendChild(mark)
        last = m.index + m[0].length
      }
      frag.appendChild(document.createTextNode(n.nodeValue.slice(last)))
      n.parentNode.replaceChild(frag, n)
    }
  }
  hits = [...body.querySelectorAll('mark')]
  cnt.textContent = q ? (hits.length ? `1/${hits.length}` : 'none') : ''
  if (hits.length) { hitAt = 0; focusHit(cnt) }
}

function focusHit (cnt) {
  hits.forEach((m, i) => m.classList.toggle('on', i === hitAt))
  const m = hits[hitAt]
  if (m) m.scrollIntoView({ block: 'center' })
  if (cnt) cnt.textContent = `${hitAt + 1}/${hits.length}`
}

function step (dir) {
  // nothing to search through: treat the arrows as jump to start / jump to end
  if (!hits.length) {
    const box = $('.msgs')
    if (dir < 0) drawEarlier(Infinity)   // the start of the chat may not be drawn yet
    if (box) box.scrollTo({ top: dir < 0 ? 0 : box.scrollHeight, behavior: 'smooth' })
    return
  }
  hitAt = (hitAt + dir + hits.length) % hits.length
  focusHit($('.find .cnt'))
}

// ---------------------------------------------------------------- usage
$('#ranges').onclick = e => {
  const b = e.target.closest('button'); if (!b) return
  days = Number(b.dataset.days)
  document.querySelectorAll('#ranges button').forEach(x => x.classList.toggle('on', x === b))
  send({ type: 'stats', days })
}
let dDays = 7, dOff = 0
$('#dranges').onclick = e => {
  const b = e.target.closest('button'); if (!b) return
  dDays = Number(b.dataset.days)
  dOff = 0
  document.querySelectorAll('#dranges button').forEach(x => x.classList.toggle('on', x === b))
  askDigest()
}

// what the card shows - unchecking a box redraws it immediately
const OPTS = { cost: true, tiles: true, models: true, chart: true, names: false }
for (const k of Object.keys(OPTS)) {
  const box = $('#opt-' + k)
  if (!box) continue
  box.checked = OPTS[k]
  box.onchange = () => { OPTS[k] = box.checked; paintPreview() }
}

const askDigest = () => send({ type: 'stats', days: dDays, digest: true, offset: dOff })

function paintPreview () {
  const data = cardImage()
  if (data) $('#cardimg').src = data
  // each row says what it is currently putting on the card
  if (!LAST) return
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text }
  set('#sub-cost', money(LAST.s.cost))
  set('#sub-models', LAST.s.models.map(m => m.name).join(' · ') || 'none in this window')
  set('#sub-chart', `${Object.keys(LAST.trend || {}).length} days`)
  set('#sub-names', OPTS.names
    ? (LAST.s.top?.[0]?.name || 'your project') + ' will be named'
    : 'Left off the card')
}

function drawStats (s, prev, trend, digest) {
  if (digest) { LASTD = { s, prev, trend, days: dDays, streaks: arguments[4] }; return drawDigest() }
  const label = { 1: 'Today', 7: 'Last 7 days', 30: 'Last 30 days', 0: 'All time' }[days]
  LAST = { s, trend, label }              // what the shareable image is drawn from
  paintPreview()
}

/** The digest: the numbers that used to crowd the card, with room to breathe. */
function drawDigest () {
  if (!LASTD) return
  const { s, prev, trend } = LASTD
  const entries = Object.entries(trend || {})
  const peak = Math.max(1, ...entries.map(([, v]) => v.tokens))
  const activeDays = entries.filter(([, v]) => v.tokens > 0).length
  const best = entries.reduce((a, b) => (b[1].tokens > (a?.[1]?.tokens || 0) ? b : a), null)
  const span = entries.length
    ? `${nice(entries[0][0])} – ${nice(entries[entries.length - 1][0])}` : ''

  const wrap = $('#digest')
  wrap.innerHTML = ''

  const nav = el('div', 'dnav')
  const back = el('button', 'iconbtn', '‹'); back.title = 'Earlier'
  const fwd = el('button', 'iconbtn', '›'); fwd.title = 'Later'
  fwd.disabled = dOff === 0
  back.onclick = () => { dOff++; askDigest() }
  fwd.onclick = () => { if (dOff > 0) { dOff--; askDigest() } }
  const mid = el('div', 'dnavmid')
  const name = dOff === 0
    ? { 1: 'Today', 7: 'Last 7 days', 30: 'Last 30 days' }[LASTD.days]
    : { 1: `${dOff} day${dOff === 1 ? '' : 's'} ago`, 7: `${dOff} week${dOff === 1 ? '' : 's'} ago`,
        30: `${dOff} month${dOff === 1 ? '' : 's'} ago` }[LASTD.days]
  mid.append(el('h2', 'dtitle', name), el('p', 'dspan', span))
  nav.append(back, mid, fwd)
  wrap.appendChild(nav)

  if (!s.tokens) {
    wrap.appendChild(el('div', 'empty', 'Nothing in this window.'))
    return
  }

  const grid = el('div', 'dgrid')
  const tile = (v, k, d) => {
    const t = el('div', 'dtile')
    t.append(el('b', '', String(v)), el('span', '', k.toUpperCase()))
    if (d) t.appendChild(d)
    grid.appendChild(t)
  }
  tile(s.sessions, 'sessions', delta(s.sessions, prev?.sessions))
  tile(nfmt(s.tokens), 'tokens', delta(s.tokens, prev?.tokens))
  tile(money(s.cost), 'cost', delta(s.cost, prev?.cost))
  tile(s.edits, 'edits', delta(s.edits, prev?.edits))
  tile(dur(s.activeMs), 'active time', delta(s.activeMs, prev?.activeMs))
  tile(`${activeDays}/${entries.length}`, 'active days')
  wrap.appendChild(grid)

  if (best && best[1].tokens) {
    const pct = prev?.cost ? Math.round((s.cost - prev.cost) / prev.cost * 100) : null
    wrap.appendChild(el('p', 'dnote',
      `${nice(best[0], true)} was your heaviest day at ${nfmt(best[1].tokens)} tokens. ` +
      `You worked on ${activeDays} of ${entries.length} days.` +
      (pct === null ? '' : ` Spend is ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the period before.`)))
  }

  // day by day, as blocks rather than a bar chart - easier to read at a glance
  wrap.appendChild(head('Day by day', `tokens · peak ${nfmt(peak)}`))
  const dayrow = el('div', 'ddays')
  for (const [d, v] of entries) {
    // green marks today, not the heaviest day - the peak already reads as the tallest
    const cell = el('div', 'dday' + (d === TODAY ? ' today' : ''))
    cell.dataset.day = d
    const box = el('div', 'dbox')
    if (v.tokens) {
      const fill = el('i')
      fill.style.height = `${Math.max(3, v.tokens / peak * 100)}%`
      box.appendChild(fill)
    }
    cell.append(box, el('span', '', new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short' })))
    if (!v.tokens) cell.classList.add('idle')
    // instant panel rather than waiting on a native tooltip
    cell.onmouseenter = () => showDay(d, v, dayrow)
    cell.onclick = () => showDay(d, v, dayrow, true)
    dayrow.appendChild(cell)
  }
  wrap.appendChild(dayrow)
  // the panel is a hover detail, not a fixture - the model and project sections
  // stay where they are until you actually point at a day
  dayrow.onmouseleave = () => { if (!PINNED) clearDay(dayrow) }
  const panel = el('div', 'dpanel')
  panel.id = 'dpanel'
  wrap.appendChild(panel)

  const st = LASTD.streaks
  if (st && st.best > 1) {
    wrap.appendChild(head('Streak'))
    const row = el('div', 'dstreak')
    row.append(streakTile(st.current, 'current run', st.current ? 'days in a row' : 'start one today'),
      streakTile(st.best, 'best run', 'days in a row'),
      streakTile(st.totalDays, 'days ever', 'with any usage'))
    wrap.appendChild(row)
  }

  const hrs = Object.entries(s.hours || {}).map(([h, n]) => [Number(h), n])
  if (hrs.length) {
    const busiest = hrs.reduce((a, b) => (b[1] > a[1] ? b : a))
    wrap.appendChild(head('When you worked', `busiest around ${hour(busiest[0])}`))
    const hpeak = busiest[1]
    const strip = el('div', 'dhours')
    for (let h = 0; h < 24; h++) {
      const n = s.hours[h] || 0
      const cell = el('div', 'dhour' + (n ? '' : ' idle'))
      const b = el('i')
      if (n) b.style.height = `${Math.max(8, n / hpeak * 100)}%`
      cell.appendChild(b)
      cell.title = n ? `${hour(h)} · ${n} messages` : `${hour(h)} · nothing`
      if (h % 6 === 0) cell.appendChild(el('span', '', hour(h, true)))
      strip.appendChild(cell)
    }
    wrap.appendChild(strip)
  }

  if (s.models.length) {
    wrap.appendChild(head('By model'))
    for (const m of s.models) {
      const row = el('div', 'dmodel')
      const top = el('div', 'dmtop')
      top.append(el('b', '', m.name), el('span', '', `${nfmt(m.tokens)} · ${money(m.cost)}`))
      const bar = el('div', 'dmbar')
      const fill = el('i')
      fill.style.width = `${(m.tokens / Math.max(1, s.tokens) * 100).toFixed(1)}%`
      bar.appendChild(fill)
      row.append(top, bar, el('p', '', `${Math.round(m.tokens / Math.max(1, s.tokens) * 100)}% of tokens`))
      wrap.appendChild(row)
    }
  }

  if (s.top?.length) {
    wrap.appendChild(head('Top projects'))
    s.top.forEach((p, i) => {
      const row = el('div', 'dproj')
      row.append(el('span', 'rank', String(i + 1)),
        el('span', 'pname', p.name),
        el('span', 'pmeta', `${p.sessions} sessions · ${nfmt(p.tokens)}`),
        el('span', 'pcost', money(p.cost)))
      wrap.appendChild(row)
    })
  }
  wrap.appendChild(el('p', 'dfoot', 'Built from your local transcripts. Nothing leaves this machine.'))
}

let PINNED = null

function clearDay (row) {
  const p = $('#dpanel')
  if (p) p.innerHTML = ''
  for (const c of row.children) c.classList.remove('sel')
}

/** The day panel: what that single day cost, in full. */
function showDay (day, v, row, pin) {
  if (PINNED && !pin && PINNED !== day) return    // a clicked day stays put
  if (pin) {
    PINNED = PINNED === day ? null : day
    if (!PINNED) return clearDay(row)
  }
  const p = $('#dpanel')
  if (!p) return
  for (const c of row.children) c.classList.toggle('sel', c.dataset.day === day)
  p.innerHTML = ''
  p.appendChild(el('div', 'dptitle', nice(day, true)))
  const line = (k, val, sub) => {
    const r = el('div', 'dprow')
    r.append(el('span', '', k), el('b', '', val))
    p.appendChild(r)
    if (sub) p.appendChild(el('div', 'dpsub', sub))
  }
  if (!v.tokens) { p.appendChild(el('div', 'dpsub', 'No usage on this day.')); return }
  line('Sessions', String(v.sessions))
  line('Messages', String(v.messages))
  line('Tokens', nfmt(v.tokens),
    `in ${nfmt(v.in)} · out ${nfmt(v.out)} · cache ${nfmt(v.cache)}`)
  line('Cost', money(v.cost))
  line('Edits', String(v.edits))
}

const TODAY = new Date().toISOString().slice(0, 10)

const nice = (d, long) => new Date(d + 'T12:00').toLocaleDateString(undefined,
  long ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })

const hour = (h, short) => {
  const am = h < 12 ? 'am' : 'pm'
  const n = h % 12 === 0 ? 12 : h % 12
  return short ? `${n}${am}` : `${n} ${am}`
}

function streakTile (n, label, sub) {
  const t = el('div', 'dtile')
  t.append(el('b', '', String(n)), el('span', '', label.toUpperCase()), el('i', 'flat', sub))
  return t
}

function head (title, right) {
  const h = el('div', 'dhead3')
  h.append(el('span', '', title.toUpperCase()))
  if (right) h.appendChild(el('em', '', right))
  return h
}

function delta (now, was) {
  if (!was) return null
  const pct = Math.round(((now - was) / was) * 100)
  if (!isFinite(pct)) return null
  const i = el('i', pct === 0 ? 'flat' : pct > 0 ? 'up' : 'down',
    pct === 0 ? 'no change' : `${pct > 0 ? '↑' : '↓'}${Math.abs(pct)}%`)
  return i
}

// ------------------------------------------------- usage card as a PNG to share
let LAST = null, LASTD = null


/** The shareable card: 1200x675, the size X and Slack render without cropping.
    Drawn on a canvas rather than screenshotting the DOM, so it is sharp at 2x and
    carries its own palette instead of the reader's theme. */
function cardImage () {
  if (!LAST) return null
  const { s, trend, label } = LAST
  const W = 1200, H = 675, R = 2
  const c = document.createElement('canvas')
  c.width = W * R; c.height = H * R
  const x = c.getContext('2d')
  x.scale(R, R)
  const F = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif'
  const M = 'ui-monospace, SFMono-Regular, Menlo, monospace'
  const INK = '#f6f2ef', DIM = '#9a9086', VIOLET = '#d97757', TEAL = '#7fb069'
  const BLUE = '#7a9dff'                       // Codex, matching its own mark
  const split = s.bySource
  const mixed = !!(split && split.codex.tokens > 0 && split.claude.tokens > 0)

  const round = (px, py, w, h, r) => {
    x.beginPath(); x.moveTo(px + r, py)
    x.arcTo(px + w, py, px + w, py + h, r); x.arcTo(px + w, py + h, px, py + h, r)
    x.arcTo(px, py + h, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath()
  }
  const text = (t, px, py, { size = 14, weight = 400, fill = INK, font = F, align = 'left' } = {}) => {
    x.fillStyle = fill; x.font = `${weight} ${size}px ${font}`; x.textAlign = align
    x.fillText(t, px, py); x.textAlign = 'left'
    return x.measureText(t).width
  }

  // backdrop: deep navy with a violet bloom behind the headline
  const bg = x.createLinearGradient(0, 0, W, H)
  bg.addColorStop(0, '#15100e'); bg.addColorStop(1, '#241a16')
  x.fillStyle = bg; x.fillRect(0, 0, W, H)
  const glow = x.createRadialGradient(300, 210, 20, 300, 210, 480)
  glow.addColorStop(0, 'rgba(217,119,87,.22)'); glow.addColorStop(1, 'rgba(217,119,87,0)')
  x.fillStyle = glow; x.fillRect(0, 0, W, H)
  x.strokeStyle = 'rgba(255,255,255,.035)'; x.lineWidth = 1
  for (let gx = 60; gx < W; gx += 60) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, H); x.stroke() }
  for (let gy = 60; gy < H; gy += 60) { x.beginPath(); x.moveTo(0, gy); x.lineTo(W, gy); x.stroke() }

  const P = 64
  text(label.toUpperCase() + (mixed ? ' IN CLAUDE CODE AND CODEX' : ' IN CLAUDE CODE'),
    P, 96, { size: 14, weight: 700, fill: VIOLET })
  text(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }),
    W - P, 96, { size: 14, fill: DIM, align: 'right' })

  const big = nfmt(s.tokens)
  const bw = text(big, P, 196, { size: 88, weight: 800 })
  text('tokens', P + bw + 16, 196, { size: 24, weight: 500, fill: DIM })
  if (OPTS.cost) {
    const cw = text(money(s.cost), P, 242, { size: 30, weight: 700, fill: TEAL })
    text('at API prices', P + cw + 12, 242, { size: 15, fill: DIM })
  }
  if (OPTS.names && s.top?.length) {
    text(s.top[0].name.toUpperCase(), P, 272, { size: 12, weight: 700, fill: DIM })
  } else if (s.top?.length) {
    text(`${s.projects} PROJECT${s.projects === 1 ? '' : 'S'}`, P, 272, { size: 12, weight: 700, fill: DIM })
  }

  // by-model panel, top right
  const models = OPTS.models ? s.models.slice(0, 4) : []
  if (models.length) {
    const pw = 400, ph = 44 + models.length * 30, px0 = W - P - pw, py0 = 128
    x.fillStyle = 'rgba(217,119,87,.09)'; round(px0, py0, pw, ph, 14); x.fill()
    x.strokeStyle = 'rgba(217,119,87,.38)'; round(px0, py0, pw, ph, 14); x.stroke()
    text('BY MODEL', px0 + 20, py0 + 28, { size: 11, weight: 700, fill: VIOLET })
    text('TOKENS', px0 + pw - 120, py0 + 28, { size: 11, weight: 700, fill: DIM, align: 'right' })
    text('API PRICE', px0 + pw - 20, py0 + 28, { size: 11, weight: 700, fill: DIM, align: 'right' })
    models.forEach((m, i) => {
      const ry = py0 + 56 + i * 30
      text(m.name, px0 + 20, ry, { size: 15, weight: 600 })
      text(nfmt(m.tokens), px0 + pw - 120, ry, { size: 15, font: M, align: 'right' })
      text(m.cost ? money(m.cost) : 'no price', px0 + pw - 20, ry,
        { size: 15, font: M, fill: m.cost ? TEAL : DIM, align: 'right' })
    })
  }

  // five tiles
  const tiles = [['SESSIONS', s.sessions], ['MESSAGES SENT', s.messages], ['FILE EDITS', s.edits],
    ['PROJECTS', s.projects], ['TIME SPENT', dur(s.activeMs)]]
  const tw = (W - P * 2 - 4 * 16) / 5
  if (OPTS.tiles) tiles.forEach(([k, v], i) => {
    const tx = P + i * (tw + 16)
    x.fillStyle = 'rgba(255,255,255,.045)'; round(tx, 296, tw, 96, 12); x.fill()
    x.strokeStyle = 'rgba(255,255,255,.07)'; round(tx, 296, tw, 96, 12); x.stroke()
    text(String(v), tx + 18, 348, { size: 32, weight: 700 })
    text(k, tx + 18, 372, { size: 11, weight: 700, fill: DIM })
  })

  // Which CLI the tokens came from. Only drawn when both are in play, and it
  // earns its space: Codex carries no price, so the headline cost covers only
  // part of the headline token count and the bar is what says so.
  if (mixed) {
    const tot = split.claude.tokens + split.codex.tokens
    const pc = split.claude.tokens / tot
    const pct = n => (n >= 0.995 ? 100 : n <= 0.005 ? 0 : Math.round(n * 100))
    text(`CLAUDE ${pct(pc)}%`, P, 412, { size: 11, weight: 700, fill: VIOLET })
    text(`CODEX ${pct(1 - pc)}% · UNPRICED`, P + 108, 412, { size: 11, weight: 700, fill: BLUE })
    const by = 418, bwid = W - P * 2, bh = 6
    x.fillStyle = 'rgba(255,255,255,.08)'; round(P, by, bwid, bh, 3); x.fill()
    x.fillStyle = VIOLET; round(P, by, Math.max(4, bwid * pc), bh, 3); x.fill()
    x.fillStyle = BLUE
    round(P + bwid * pc, by, Math.max(4, bwid * (1 - pc)), bh, 3); x.fill()
  }

  // Tokens per day, labelled: a figure on each bar and a dated axis, so the image
  // still reads on its own. The old unlabelled model strip is gone - the by-model
  // panel above already says the same thing, with names.
  const entries = OPTS.chart ? Object.entries(trend || {}) : []
  if (entries.length) {
    const peak = Math.max(1, ...entries.map(([, v]) => v.tokens))
    const active = entries.filter(([, v]) => v.tokens).length
    text(`TOKENS PER DAY · ${entries.length} DAYS`, P, 432, { size: 11, weight: 700, fill: DIM })
    text(`${active} ACTIVE · PEAK ${nfmt(peak)} · TODAY IN GREEN`, W - P, 432,
      { size: 11, weight: 700, fill: DIM, align: 'right' })

    const top = 462, floor = 584
    const gw = (W - P * 2) / entries.length
    const wide = gw > 46                         // room for a label under each bar
    entries.forEach(([day, v], i) => {
      const bx = P + i * gw + 3
      const bw = Math.max(2, gw - 8)
      const today = i === entries.length - 1
      if (v.tokens) {
        const h = Math.max(5, v.tokens / peak * (floor - top))
        x.fillStyle = today ? TEAL : 'rgba(217,119,87,.72)'
        round(bx, floor - h, bw, h, 4); x.fill()
        if (wide) {
          text(nfmt(v.tokens), bx + bw / 2, floor - h - 9,
            { size: 12, weight: 700, fill: today ? TEAL : INK, align: 'center' })
        }
      } else {
        x.fillStyle = 'rgba(255,255,255,.06)'
        round(bx, floor - 4, bw, 4, 2); x.fill()
      }
      if (wide) {
        const d = new Date(day + 'T12:00')
        text(d.toLocaleDateString(undefined, { weekday: 'short' }), bx + bw / 2, floor + 20,
          { size: 12, fill: today ? INK : DIM, weight: today ? 700 : 400, align: 'center' })
        text(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
          bx + bw / 2, floor + 36, { size: 10.5, fill: 'rgba(139,147,167,.6)', align: 'center' })
      }
    })
    if (!wide) {
      text(niceDate(entries[0][0]), P, floor + 22, { size: 11, fill: DIM })
      text(niceDate(entries[entries.length - 1][0]), W - P, floor + 22,
        { size: 11, fill: DIM, align: 'right' })
    }
  }

  x.fillStyle = 'rgba(255,255,255,.08)'
  x.fillRect(P, 634, W - P * 2, 1)
  text('Agent Logbook', P, 659, { size: 13, weight: 700, fill: DIM })
  text((mixed ? 'read from local Claude Code and Codex transcripts'
    : 'read from local Claude Code transcripts') + ' · nothing uploaded', W - P, 659,
    { size: 12, fill: DIM, align: 'right' })
  return c.toDataURL('image/png')
}

$('#shotcopy').append(icon('copy'), el('span', '', 'Copy image'))
$('#shot').append(icon('export'), el('span', '', 'Save PNG…'))

const shotName = () => `claude-usage-${new Date().toISOString().slice(0, 10)}.png`
$('#shot').onclick = () => {
  const data = cardImage()
  if (data) send({ type: 'saveImage', data, name: shotName() })
}
$('#shotcopy').onclick = () => {
  const data = cardImage()
  if (data) send({ type: 'copyImage', data })
}

// ---------------------------------------------------------------- memory
function renderMem () {
  const q = $('#memq').value.trim().toLowerCase()
  const list = MEM.filter(m => !q ||
    (m.title + m.description + m.body + m.project).toLowerCase().includes(q))
  const rows = $('#memrows')
  rows.innerHTML = ''

  const byProject = new Map()
  for (const m of list) {
    if (!byProject.has(m.project)) byProject.set(m.project, [])
    byProject.get(m.project).push(m)
  }
  for (const [p, items] of byProject) {
    const head = el('div', 'ghead')
    head.append(icon('folder', 'gfolder'), el('span', 'gname', p),
      el('span', 'gcount', String(items.length)))
    rows.appendChild(head)
    // the index is the contents page for the rest - it goes first
    items.sort((a, b) => (b.isIndex ? 1 : 0) - (a.isIndex ? 1 : 0) || b.mtime - a.mtime)
    for (const m of items) {
      const card = el('div', 'memcard' + (m.isIndex ? ' isindex' : ''))
      const top = el('div', 'memtop')
      // the same mark the chat list uses, so a note is placed at a glance
      top.appendChild(sourceIcon(m.provider))
      if (m.isIndex) top.appendChild(icon('list', 'memico'))
      top.append(el('b', '', m.isIndex ? 'Memory index' : m.title))
      if (m.type) top.appendChild(el('span', memClass(m.type), String(m.type).toUpperCase()))
      card.appendChild(top)
      if (m.description) card.appendChild(el('p', 'memdesc', m.description.replace(/^["']|["']$/g, '')))
      card.appendChild(el('span', 'memwhen', ago(m.mtime) + ' ago'))
      card.onclick = () => showMemory(m)
      rows.appendChild(card)
    }
  }
  if (!list.length) rows.appendChild(el('div', 'empty', q ? 'No memory matches that.' : 'No memories yet.'))
  $('#memmeta').textContent =
    `${list.length} ${list.length === 1 ? 'memory' : 'memories'} written by agents on this machine`
}

/** Read a memory in place, rather than sending it to the editor. */
function showMemory (m) {
  $('#membar').hidden = true
  $('#memrows').hidden = true
  const box = $('#memread')
  box.hidden = false
  box.innerHTML = ''

  const head = el('div', 'dhead')
  const top = el('div', 'dtop')
  const back = el('button', 'iconbtn', '‹')
  back.title = 'All memories'
  back.onclick = closeMemory
  const h = el('h2', '', m.title)
  top.append(back, h)
  if (m.type) top.appendChild(el('span', memClass(m.type), String(m.type).toUpperCase()))
  head.appendChild(top)
  head.appendChild(el('div', 'facts', `${m.project} · updated ${ago(m.mtime)} ago`))

  const acts = el('div', 'acts')
  const mk = (name, tip, fn) => {
    const b = el('button', 'btn ico')
    b.appendChild(icon(name)); b.title = tip; b.onclick = fn
    return b
  }
  acts.append(
    mk('copy', 'Copy the text', () => send({ type: 'copy', text: m.body, label: 'Memory copied' })),
    mk('export', 'Open the file to edit', () => send({ type: 'openMemory', path: m.path })),
    mk('open', 'Reveal in Finder', () => send({ type: 'openFolder', path: m.path })))
  head.appendChild(acts)
  box.appendChild(head)

  const body = el('div', 'membody')
  body.innerHTML = window.md(m.body)
  addCopyButtons(body)
  for (const a of body.querySelectorAll('a.memlink')) {
    const file = a.dataset.file
    const target = MEM.find(x => x.path.endsWith('/' + file) && x.project === m.project)
      || MEM.find(x => x.path.endsWith('/' + file))
    if (!target) { a.classList.add('dead'); a.title = 'No memory called ' + file; continue }
    a.title = target.description || target.title
    a.onclick = e => { e.preventDefault(); showMemory(target) }
  }
  box.appendChild(body)
  tips(box)
}

function closeMemory () {
  $('#memread').hidden = true
  $('#memread').innerHTML = ''
  $('#membar').hidden = false
  $('#memrows').hidden = false
}
$('#memq').oninput = renderMem

// ---------------------------------------------------------------- bridge
window.addEventListener('message', e => {
  const m = e.data
  if (!m || typeof m.type !== 'string') return
  // the board shows chats but never opens one: that goes to the sidebar
  if (BOARD_MODE && (m.type === 'session' || m.type === 'results')) return
  if (m.type === 'env' && BOARD_MODE && m.cfg) send({ type: 'board' })
  if (m.type === 'env') {
    // partial env messages (a group edit, a settings snapshot) leave it alone
    if ('here' in m) HERE = new Set([].concat(m.here || []))
    if (m.target) TARGET = m.target
    if (m.pageSize) PAGE = m.pageSize
    if (m.sort) SORT = m.sort
    if (m.dateFormat) DATEFMT = m.dateFormat
    if (typeof m.liveFirst === 'boolean') LIVE_FIRST = m.liveFirst
    if (m.cfg) { CFG = m.cfg; drawLimits(null); if (TAB === 'settings') renderSettings() }
    if (m.groups) GROUPS = m.groups
    if ($('#detail').hidden) renderList()
  }
  if (m.type === 'mcp') { MCP = m.data; paintMcp() }
  if (m.type === 'mcpActivity') { ACTIVITY = m.data; paintActivity() }
  if (m.type === 'pendingChat' && !BOARD_MODE) showPending(m.id)
  if (m.type === 'pendingGone' && PENDING_CHAT === m.id) { PENDING_CHAT = null; if (!CUR) closeDetail() }
  if (m.type === 'seen') { READ_AT[m.id] = m.at; if (BOARD_MODE) paintSeen() }
  if (m.type === 'board') {
    if (m.seen) READ_AT = m.seen
    const on = new Set(m.data.map(c => c.id))
    BOARD_ELSEWHERE = new Set(SESSIONS.filter(x => x.live && !on.has(x.id)).map(x => x.id))
    keepTyping(() => renderBoard(m.data))
  }
  if (m.type === 'sessions' && BOARD_MODE) keepTyping(() => syncBoard(m.data))
  if (m.type === 'boardReplied') boardReplied(m)
  if (m.type === 'trashed') {
    TRASHED = m.data
    if ($('#detail').hidden) liveRender()
  }
  if (m.type === 'sessions') {
    SESSIONS = m.data
    if ($('#detail').hidden) liveRender()
    else paintRunner()
  }
  // a live update for another chat, or the new chat turning up after you
  // moved on, must not pull you away from what you are reading
  if (m.type === 'session' && m.data && m.fromPending && PENDING_CHAT !== m.data.id) return
  // the new chat arriving, or you opening some other chat meanwhile, ends the wait
  if (m.type === 'session' && m.data && (m.fromPending || !m.live)) PENDING_CHAT = null
  if (m.type === 'session' && m.data) {
    const p = PERF && !m.live && PERF.id === m.data.id ? PERF : null
    if (p) p.arrived = performance.now() - p.t0
    showDetail(m.data, m.live)
    if (p) PERF = null
    if (p) {
      p.drawn = performance.now() - p.t0
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
        p.shown = performance.now() - p.t0
        send({ type: 'perf', data: { id: p.id, arrived: Math.round(p.arrived), drawn: Math.round(p.drawn), shown: Math.round(p.shown), find: Math.round(p.find || 0) } })
      })))
    }
  }
  if (m.type === 'stats') drawStats(m.data, m.prev, m.trend, m.digest, m.streaks)
  if (m.type === 'memories') { MEM = m.data; renderMem() }
  if (m.type === 'limits') drawLimits(m.data)
  if (m.type === 'image') putImage(m)
  if (m.type === 'resources') { RES = m.data; paintResources(); if (BOARD_MODE) paintBoardRes() }
  if (m.type === 'results') {
    // results stream in one chat at a time; the last message carries the totals
    const q = ($('#q').value || '').trim().toLowerCase()
    // an answer to something since typed over. Compared without case: the query
    // goes out as typed, and a capital letter made every answer look stale
    if (m.q && String(m.q).trim().toLowerCase() !== q) return
    if (m.chat) {
      if (!RESULTS || RESULTS.q !== m.q) {
        RESULTS = { q: m.q, chats: [], matches: 0, scanned: 0, total: m.at?.total || 0,
          ms: 0, truncated: false, streaming: true }
      }
      if (!RESULTS.chats.some(c => c.id === m.chat.id)) RESULTS.chats.push(m.chat)
      RESULTS.matches = m.at?.matches ?? RESULTS.matches
      RESULTS.scanned = m.at?.scanned ?? RESULTS.scanned
    } else {
      RESULTS = m.data
    }
    SEARCHING = ''
    // redraw on a beat rather than per result: sixty arriving in a second would
    // otherwise rebuild the whole list sixty times
    if ($('#detail').hidden) {
      if (!m.chat) { clearTimeout(streamPaint); streamPaint = 0; renderList() }
      else if (!streamPaint) {
        streamPaint = setTimeout(() => { streamPaint = 0; if ($('#detail').hidden) renderList() }, 150)
      }
    }
  }
  if (m.type === 'analytics') showAnalytics(m.data)
})
$('#rows').onscroll = onListScroll
// a wider or taller panel should fill itself too
new ResizeObserver(() => { if ($('#detail').hidden) fillViewport() }).observe($('#rows'))

/**
 * Slack and most composers turn a <p> into a single line break, so blocks paste
 * with no gap. Flatten to one block with explicit <br><br> between, which every
 * target renders as a real blank line while keeping bold and links.
 */
const BLOCKS = new Set(['p', 'ul', 'ol', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'div', 'hr'])
function flatHtml (html) {
  const host = document.createElement('div')
  host.innerHTML = html
  // Paragraphs are flattened to text joined by blank lines, because Slack drops
  // the gap between <p> blocks and runs them together. Lists are kept as real
  // lists: turned into "•" characters they pasted as plain text rather than as
  // bullets Slack can edit, and numbered lists lost their numbering. Text that
  // sits outside any block - part of a line, a bold phrase - keeps its own tags,
  // so bold, italics and links survive a partial selection.
  const pieces = []
  let run = ''
  const flush = () => { if (run.trim()) pieces.push({ html: run, list: false }); run = '' }
  for (const node of host.childNodes) {
    if (node.nodeType === 3) { run += esc(node.nodeValue); continue }
    if (node.nodeType !== 1) continue
    const tag = node.nodeName.toLowerCase()
    if (!BLOCKS.has(tag)) { run += cleanInline(node); continue }
    flush()
    const isList = tag === 'ul' || tag === 'ol'
    let piece
    if (isList) piece = plainList(node).outerHTML
    else if (tag === 'pre') piece = `<pre>${esc(node.textContent).replace(/\n/g, '<br>')}</pre>`
    else piece = cleanInline(node, true)
    if (piece && piece.trim()) pieces.push({ html: piece, list: isList })
  }
  flush()
  let out = ''
  pieces.forEach((p, i) => {
    // a list is a block of its own, so one break either side is a blank line
    if (i) out += (p.list || pieces[i - 1].list) ? '<br>' : '<br><br>'
    out += p.html
  })
  return out
}

/** An element's html without the reader's classes, styles and buttons; inner only for a block. */
// a memory's type comes from its frontmatter and becomes a class name: one plain word or none
const memClass = t => /^[a-z]{1,20}$/.test(t) ? 'memtype ' + t : 'memtype'

/**
 * What goes on the clipboard as html: formatting tags only, and of attributes
 * only a link's web address, so nothing from a transcript rides along into
 * the app it is pasted into.
 */
const KEEP_TAGS = new Set(['b', 'strong', 'i', 'em', 'del', 'code', 'a', 'ul', 'ol', 'li', 'br', 'pre', 'p', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'div'])
function scrub (root) {
  for (const n of [root, ...root.querySelectorAll('*')]) {
    if (n !== root && !KEEP_TAGS.has(n.nodeName.toLowerCase())) { n.replaceWith(document.createTextNode(n.textContent)); continue }
    for (const a of [...n.attributes]) {
      if (!(a.name === 'href' && /^https?:/i.test(a.value))) n.removeAttribute(a.name)
    }
  }
}

function cleanInline (node, innerOnly) {
  const copy = node.cloneNode(true)
  for (const b of copy.querySelectorAll('button')) b.remove()
  scrub(copy)
  return innerOnly ? copy.innerHTML : copy.outerHTML
}

/** A list without the reader's styling hooks, so it pastes as a plain list. */
function plainList (list) {
  const copy = list.cloneNode(true)
  for (const b of copy.querySelectorAll('button')) b.remove()
  scrub(copy)
  return copy
}

/** Put both flavours on the clipboard: markdown for plain targets, html for rich. */
function copyRich (markdown, html) {
  const onCopy = e => {
    e.clipboardData.setData('text/plain', markdown)
    e.clipboardData.setData('text/html', html)
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy, { once: true, capture: true })
  // a selection is required before the browser will run a copy command
  const holder = el('div')
  holder.textContent = markdown
  holder.style.cssText = 'position:fixed;left:-9999px;white-space:pre-wrap'
  document.body.appendChild(holder)
  const range = document.createRange()
  range.selectNodeContents(holder)
  const sel = document.getSelection()
  sel.removeAllRanges(); sel.addRange(range)
  const ok = document.execCommand('copy')
  sel.removeAllRanges()
  holder.remove()
  return ok
}

/**
 * Copying a selection out of rendered HTML loses the blank line between blocks,
 * so a pasted post arrives as one run-on wall. Rebuild the plain-text flavour
 * with real paragraph breaks, and hand over the HTML so rich targets keep bold.
 */
document.addEventListener('copy', e => {
  const sel = document.getSelection()
  if (!sel || sel.isCollapsed) return
  // only text inside a message: the find box and other inputs copy as usual
  const range = sel.getRangeAt(0)
  const inMsg = n => (n.nodeType === 3 ? n.parentElement : n)?.closest?.('.bubble, .bcbody')
  if (!inMsg(range.commonAncestorContainer)) return
  // Even part of one line comes through here: left to the browser, a phrase
  // picked out of a list item kept its bold in a form Slack ignores.
  // A copy of part of a numbered list loses the items before it, so each item's
  // real number is read from the page first and travels with the copy.
  const ancEl = n => (n.nodeType === 3 ? n.parentElement : n)
  const scope = ancEl(range.commonAncestorContainer).closest('ol') || ancEl(range.commonAncestorContainer)
  const numbered = [...scope.querySelectorAll('ol > li')]
  for (const li of numbered) {
    const ol = li.parentElement
    li.dataset.copyN = String((Number(ol.getAttribute('start')) || 1) + [...ol.children].indexOf(li))
  }
  const frag = range.cloneContents()
  for (const li of numbered) delete li.dataset.copyN
  const host = document.createElement('div')
  host.appendChild(frag)
  // items picked from inside one list come without their list: put it back,
  // numbered or bulleted as it was
  if ([...host.children].some(n => n.nodeName === 'LI')) {
    const anc = range.commonAncestorContainer
    const kind = (anc.nodeType === 3 ? anc.parentElement : anc).closest('ol, ul')?.nodeName.toLowerCase() || 'ul'
    const list = document.createElement(kind)
    for (const n of [...host.childNodes]) list.appendChild(n)
    host.appendChild(list)
  }

  // The plain text is written as Markdown, the same as the copy button's. Slack
  // builds a paste from the plain text and turns its Markdown into formatting,
  // so a selection copied as bare words lost every link and bold on the way.
  // `label` is set inside a link's text: plain text there has its brackets and
  // backslashes escaped so "a]b" cannot close the label early, while code
  // inside the link is left as it is - Markdown reads a code span literally.
  const walk = (node, label = false) => {
    if (node.nodeType === 3) return label ? node.nodeValue.replace(/[\\[\]]/g, '\\$&') : node.nodeValue
    const tag = node.nodeName.toLowerCase()
    if (tag === 'button' || node.classList?.contains('msgcopy')) return ''
    const inside = tag === 'a' ? true : tag === 'code' ? false : label
    const inner = [...node.childNodes].map(n => walk(n, inside)).join('')
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      const plain = node.textContent.trim()
      if (!/^https?:\/\//i.test(href)) return [...node.childNodes].map(n => walk(n, label)).join('')
      if (plain === href) return href
      // Parentheses that pair up stay as they are, as in .../Mercury_(planet):
      // Markdown reads a balanced pair as part of the address, and some servers
      // treat %28 and "(" as different pages. An unpaired one, or one a
      // backslash could escape, would end the link early, so then they are
      // encoded. Angle brackets and spaces always are.
      let depth = 0
      const paired = !href.includes('\\') &&
        [...href].every(c => (depth += c === '(' ? 1 : c === ')' ? -1 : 0) >= 0) && depth === 0
      const dest = href.replace(paired ? /[<>\s]/g : /[()<>\s]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
      return `[${inner}](${dest})`
    }
    if ((tag === 'strong' || tag === 'b') && inner.trim()) return `**${inner}**`
    if ((tag === 'em' || tag === 'i') && inner.trim()) return `_${inner}_`
    if (tag === 'code' && node.parentElement?.nodeName !== 'PRE') {
      // a fence longer than any run of backticks inside, padded where the code
      // starts or ends with one, so it stays a single code span
      const longest = Math.max(0, ...(inner.match(/`+/g) || []).map(r => r.length))
      const fence = '`'.repeat(longest + 1)
      const pad = /^`|`$/.test(inner) ? ' ' : ''
      return fence + pad + inner + pad + fence
    }
    if (tag === 'li') {
      // numbered items keep the number they had on the page
      const list = node.parentElement
      const n = list?.nodeName === 'OL' || node.dataset.copyN
        ? (node.dataset.copyN || (Number(list?.getAttribute('start')) || 1) + [...(list?.children || [])].indexOf(node)) + '. '
        : '- '
      return n + inner.trim() + '\n'
    }
    if (tag === 'br') return '\n'
    if (['p', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table'].includes(tag)) {
      return inner.trim() + '\n\n'
    }
    return inner
  }
  const text = walk(host).replace(/\n{3,}/g, '\n\n').trim()
  e.clipboardData.setData('text/plain', text)
  e.clipboardData.setData('text/html', flatHtml(host.innerHTML))
  e.preventDefault()
})

// ---------------------------------------------------------------- live board
// Every running chat on one page: is it working or done, what you last asked,
// and what it last said - with the reply ready to copy. Only cards whose chat
// changed are redrawn, so a reply you are reading or selecting stays put.
const BOARD_MODE = document.body.dataset.mode === 'board'
const BCARDS = new Map()     // chat id -> { card, sig }
let BOARD_ELSEWHERE = new Set()   // running chats the board leaves out, being another window's
let boardAsk = 0
function askBoard () {
  // a working chat writes many times a second; once a second is plenty here
  if (boardAsk) return
  boardAsk = setTimeout(() => { boardAsk = 0; send({ type: 'board' }) }, 800)
}

const WAITING_TEXT = { permission: 'Needs your approval', question: 'Asking you a question', plan: 'Waiting for you to approve a plan' }
function boardStatus (c) {
  // stopped on something only you can answer: say so, and what it is
  if (c.waiting) return WAITING_TEXT[c.waiting] + (c.waiting === 'permission' && c.doing ? ' · ' + c.doing : '')
  const busy = c.status === 'busy'
  return busy
    ? `Working${c.askTs ? ' · ' + ago(c.askTs) : ''}${c.doing ? ' · ' + c.doing : ''}`
    : c.replyTs ? `Replied ${ago(c.replyTs)} ago` : 'Waiting for you'
}

/**
 * New or read. A reply counts as read once you rest on its card, open the
 * chat, reply, or go to its terminal; read cards dim so the new ones stand out.
 */
let READ_AT = {}
const isNew = c => c.status !== 'busy' && !c.waiting && (c.replyTs || 0) > (READ_AT[c.id] || 0)
function paintSeen () {
  for (const [id, x] of BCARDS) {
    const fresh = isNew(x.data)
    x.card.classList.toggle('unseen', fresh)
    x.card.classList.toggle('read', !fresh && x.data.status !== 'busy' && !x.data.waiting)
  }
}
function lookedAt (id) {
  if (!id || !(BCARDS.get(id) && isNew(BCARDS.get(id).data))) return
  READ_AT[id] = Date.now()
  paintSeen()
  send({ type: 'markSeen', id })
}

// a chat starts loading when the pointer settles on it, so the click is instant
let hoverTimer = 0
function warmOnHover (node, id) {
  node.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => send({ type: 'prefetch', id }), 120)
  })
  node.addEventListener('pointerleave', () => clearTimeout(hoverTimer))
}

/**
 * The question at the end of a reply, if Claude finished by asking one - "Want
 * me to push?" - which is the part of a long report that actually needs you.
 * Only a short one counts: a long paragraph with a question mark in it is
 * still a report.
 */
function claudeAsks (reply) {
  const text = String(reply || '').replace(/```[\s\S]*?```/g, '').trim()
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  for (const p of paras.slice(-2).reverse()) {
    if (!p.includes('?')) continue
    // a list of questions is kept whole; otherwise from its first question on
    if (/^\s*([-*•]|\d+[.)])\s/m.test(p)) return p.length <= 400 ? p : ''
    const parts = p.split(/(?<=[.!?])\s+/)
    const isQ = s => /\?["')\]]*$/.test(s)
    const at = parts.findIndex(isQ)
    if (at < 0) continue
    // up to the last question, not the remark after it
    const end = parts.length - [...parts].reverse().findIndex(isQ)
    // the whole paragraph it ends: "Want it?" alone says nothing without the
    // sentences it points back to. A long paragraph keeps just the two before.
    const whole = parts.slice(0, end).join(' ').trim()
    if (whole.length <= 420) return whole
    const q = parts.slice(Math.max(0, at - 2), end).join(' ').trim()
    return q.length <= 420 ? q : parts.slice(at, end).join(' ').trim().slice(0, 420)
  }
  return ''
}

/**
 * One-tap answers read from the reply itself. Only what can be read with
 * confidence becomes a button - a wrong suggestion is worse than none, so a
 * choice that does not split into two short options gives no buttons at all.
 */
const ASK_PREFIX = /^(?:so,?\s+)?(?:do you want me to|would you like me to|want me to|should i|shall i|ok to|okay to|happy for me to)\s+/i
function replyChips (reply) {
  const ask = claudeAsks(reply)
  const chips = []
  const add = (label, send = label, tip = '') => {
    if (chips.length < 5 && !chips.some(x => x.label.toLowerCase() === label.toLowerCase())) chips.push({ label, send, tip })
  }
  const text = String(reply || '')
  if (ask) {
    // the last question in the paragraph is the one being asked
    const qs = ask.split(/(?<=[.!?])\s+/).filter(s => /\?["')\]]*$/.test(s))
    const q = (qs[qs.length - 1] || '').trim()
    const or = q.replace(/\?["')\]]*$/, '').split(/\s*,?\s+or\s+/i)
    const short = s => s && s.split(/\s+/).length <= 5 && s.length <= 32 && !/[,:;]/.test(s)
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
    if (/\bor\b/i.test(q)) {
      // "Push it, or keep it local?" - two short options, or nothing
      if (or.length === 2) {
        const a = or[0].replace(ASK_PREFIX, '').trim(), b = or[1].trim()
        if (short(a) && short(b)) { add(cap(a)); add(cap(b)) }
      }
    } else if (ASK_PREFIX.test(q) || /^(?:want it|want them|should i|shall i|sound good|ok|okay|ready|go ahead)\b/i.test(q)) {
      add('Yes'); add('No')
      // work waiting to be pushed: the answer usually wants that too
      if (/\bnot pushed\b|\blocal only\b|\bsay ["“']?push\b/i.test(text)) add('Yes, and push')
    }
    // "Which one?" after a numbered list: the numbers, each showing its option on hover
    if (!chips.length && /\b(which|pick|choose|one of|go with|start with)\b/i.test(q)) {
      const items = [...text.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)].slice(-5)
      if (items.length >= 2 && items.length <= 5) for (const m of items) add(m[1], m[1], m[2].replace(/\*\*/g, ''))
    }
  }
  // a word Claude asks you to reply with: Say "push" when you want it on GitHub
  // only a direct instruction, starting its sentence, in the closing lines - "the
  // table needs to say 'keep'" is not one, and made a wrong button
  const tail = text.split(/\n\s*\n/).slice(-2).join('\n')
  const word = /(?:^|[.!?]\s+|\n)(?:just\s+|then\s+)?(?:say|reply|type)\s+["“']([\w -]{1,20})["”']/i.exec(tail)
  if (word) add(word[1])
  return chips
}

function boardCard (c) {
  const card = el('div', 'bcard' + (c.status === 'busy' ? ' busy' : '') + (c.waiting ? ' needs' : ''))
  card.dataset.id = c.id
  warmOnHover(card, c.id)
  // resting on a card for a moment counts as reading it
  let lookTimer = 0
  card.addEventListener('mouseenter', () => { lookTimer = setTimeout(() => lookedAt(c.id), 1500) })
  card.addEventListener('mouseleave', () => clearTimeout(lookTimer))
  card.addEventListener('click', () => lookedAt(c.id))   // Show all, copy, a link - any of them is reading it
  // the logo says which agent; the strip only separates the title from the text
  const head = el('div', 'bctop ' + (c.provider === 'codex' ? 'codex' : 'claude'))
  head.append(sourceIcon(c.provider || 'claude'), el('span', 'bctitle', c.title || '(untitled)'))
  const acts = el('div', 'bcacts')
  const btn = (name, tip, fn) => {
    const b = el('button', 'bcicon')
    b.appendChild(icon(name))
    b.title = tip
    b.onclick = fn
    return b
  }
  acts.append(
    btn('open', 'Open the whole chat', () => send({ type: 'openChat', id: c.id })),
    btn('terminal', 'Go to its terminal', () => send({ type: 'resume', id: c.id, target: 'terminal' })))
  head.appendChild(acts)

  // status first, since that is what the board is for; the figures only when
  // one needs your attention
  const status = el('div', 'bcstatus')
  status.append(el('span', c.waiting ? 'dot needs' : c.status === 'busy' ? 'spinner' : 'dot idle'), el('span', 'bcstext', boardStatus(c)))
  status.appendChild(el('span', 'bcnew', 'New'))
  const pct = c.window ? Math.round(c.context / c.window * 100) : 0
  if (pct >= 90) status.appendChild(el('span', 'bcwarn', `context ${pct}% full`))
  const res = el('span', 'bcres')
  status.appendChild(res)
  card.append(head, status)
  if (c.ask) {
    // one line: the full text is a hover away
    const ask = el('div', 'bcask')
    const at = el('div', 'bcasktext', c.ask)
    at.title = c.ask
    ask.append(el('span', 'bclabel', 'You'), at)
    card.appendChild(ask)
  }
  // a working chat needs nothing from you yet: what it is doing is enough
  if (c.status === 'busy' && !c.waiting) {
    card.classList.add('slim')
    // a reply Claude has already written - often while background agents run -
    // is shown short, so it is not hidden until the whole turn ends
    if (c.reply && (c.replyTs || 0) >= (c.askTs || 0)) {
      const latest = el('div', 'bclatest')
      const body = el('div', 'bubble bcbody bcshort')
      body.dataset.src = c.reply
      body.innerHTML = window.md(c.reply)
      const more = el('button', 'bcmore', 'Show all')
      more.hidden = true
      more.onclick = () => {
        const open = body.classList.toggle('open')
        body.classList.toggle('clipped', !open)
        more.textContent = open ? 'Show less' : 'Show all'
      }
      latest.append(el('span', 'bclabel', 'Latest from Claude'), body, more)
      card.appendChild(latest)
      requestAnimationFrame(() => {
        const cut = body.scrollHeight > body.clientHeight + 4
        body.classList.toggle('clipped', cut)
        more.hidden = !cut
      })
    }
    return card
  }
  if (!c.reply && !c.ask) {
    card.appendChild(el('div', 'bcempty', 'Nothing asked yet'))
    return card
  }
  // what needs you, above the report it ends
  const asks = c.status !== 'busy' ? claudeAsks(c.reply) : ''
  if (asks) {
    const q = el('div', 'bcq')
    const qt = el('div', 'bcqtext')
    qt.innerHTML = window.md(asks)
    q.append(el('span', 'bclabel', 'Claude asks'), qt)
    card.appendChild(q)
  }
  const reply = el('div', 'bcreply')
  const rh = el('div', 'bcrhead')
  rh.appendChild(el('span', 'bclabel', c.status === 'busy' ? 'Latest from Claude' : 'Claude replied'))
  if (c.reply) rh.appendChild(msgCopyButton(c.reply))
  // with the question pulled out, the report itself starts folded shorter
  const body = el('div', 'bubble bcbody' + (asks ? ' short' : ''))
  if (c.reply) {
    body.dataset.src = c.reply
    body.innerHTML = window.md(c.reply)
    addCopyButtons(body)
  } else body.appendChild(el('span', 'bcnone', c.ask ? 'Nothing yet' : 'Nothing asked yet'))
  reply.append(rh, body)
  // only once it is on the page can it tell whether it was cut
  if (c.reply && asks) {
    // the question says what is needed; the report behind it is one click away
    reply.classList.add('folded')
    const more = el('button', 'bcmore', 'Show the full reply')
    more.onclick = () => {
      const open = reply.classList.toggle('folded') === false
      body.classList.add('open')
      more.textContent = open ? 'Hide the reply' : 'Show the full reply'
    }
    reply.appendChild(more)
  } else if (c.reply) {
    const more = el('button', 'bcmore', 'Show all')
    more.hidden = true
    more.onclick = () => {
      const open = body.classList.toggle('open')
      body.classList.toggle('clipped', !open)
      more.textContent = open ? 'Show less' : 'Show all'
    }
    reply.appendChild(more)
    requestAnimationFrame(() => {
      const cut = body.scrollHeight > body.clientHeight + 4
      body.classList.toggle('clipped', cut)
      more.hidden = !cut
    })
  }
  card.appendChild(reply)
  card.appendChild(replyBox(c))
  return card
}

/**
 * Answer a chat from its card: the text is typed into the terminal running it.
 * What you type is kept per chat, so a card redrawn by a new reply mid-sentence
 * does not lose it. Enter sends, Shift+Enter is a new line.
 */
const DRAFTS = new Map()           // chat id -> unsent text
function replyBox (c) {
  const box = el('div', 'bcsend')
  const ta = el('textarea', 'bcinput')
  ta.rows = 1
  ta.placeholder = c.status === 'busy' ? 'Reply - Claude takes it after this turn' : 'Reply to this chat…'
  ta.value = DRAFTS.get(c.id) || ''
  const go = el('button', 'bcgo')
  go.appendChild(icon('play'))
  go.title = 'Send to its terminal (Enter)'
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px' }
  const submit = () => {
    const text = ta.value.trim()
    if (!text) return
    go.disabled = true
    send({ type: 'boardReply', id: c.id, text })
  }
  ta.oninput = () => { DRAFTS.set(c.id, ta.value); fit() }
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  }
  go.onclick = submit
  box.append(ta, go)
  requestAnimationFrame(fit)
  // answers read from this chat's own last reply - none when nothing is clear
  const quick = c.status !== 'busy' ? replyChips(c.reply) : []
  if (!quick.length) return box
  const wrap = el('div', 'bcsendwrap')
  const chips = el('div', 'bcquick')
  for (const q of quick) {
    const b = el('button', 'bcchip', q.label)
    b.title = q.tip ? `${q.tip}\n\nSends "${q.send}"` : `Send "${q.send}" to this chat`
    b.onclick = () => { for (const x of chips.children) x.disabled = true; send({ type: 'boardReply', id: c.id, text: q.send }) }
    chips.appendChild(b)
  }
  wrap.append(box, chips)
  return wrap
}

/** The host's answer to a reply: sent clears the box, otherwise the text stays. */
function boardReplied (m) {
  const card = document.querySelector(`.bcard[data-id="${CSS.escape(m.id)}"], .bold-row[data-id="${CSS.escape(m.id)}"] + .bcard`)
  const ta = card?.querySelector('.bcinput'), go = card?.querySelector('.bcgo')
  if (go) go.disabled = false
  for (const b of card?.querySelectorAll('.bcchip') || []) b.disabled = false
  if (!m.ok) return
  DRAFTS.delete(m.id)
  // let go of the box once sent, so the board is free to move this chat up
  if (ta) { ta.value = ''; ta.style.height = 'auto'; ta.placeholder = 'Sent - reply again…'; ta.blur() }
  boardCatchUp()
}

/**
 * Run a board update without taking the cursor out of a reply you are typing.
 * Moving a card between columns, or drawing it afresh, drops the focus from
 * any box inside it - so it is put back, with the caret where it was.
 */
function keepTyping (fn) {
  const a = document.activeElement
  if (!a?.classList?.contains('bcinput')) return fn()
  const id = a.closest('.bcard')?.dataset.id
  const s = a.selectionStart, e = a.selectionEnd
  try { return fn() } finally {
    const ta = a.isConnected ? a : document.querySelector(`.bcard[data-id="${CSS.escape(id || '')}"] .bcinput`)
    if (ta) {
      if (document.activeElement !== ta) ta.focus({ preventScroll: true })
      try { ta.setSelectionRange(s, e) } catch {}
    }
  }
}

/** A card about to be replaced: carry the cursor over if you were typing in it. */
function swapCard (oldCard, card) {
  const typing = oldCard.contains(document.activeElement) && document.activeElement.classList.contains('bcinput')
  oldCard.replaceWith(card)
  if (typing) {
    const ta = card.querySelector('.bcinput')
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length) }
  }
}

function paintBoardRes () {
  for (const [id, { card }] of BCARDS) {
    const r = RES?.sessions?.[id]
    const n = card.querySelector('.bcres')
    if (!n) continue
    // only a chat that is weighing the laptop down says so
    n.textContent = r && heavy(r) ? resText(r) : ''
  }
}

/**
 * The chat list's own update, applied to the board the moment it arrives:
 * the same running state reaches both views together. A chat that stopped
 * leaves at once, a status flip redraws only its card, and a chat the board
 * has not seen yet is fetched straight away rather than on the next round.
 */
/** Which section a chat belongs in: needs you, working, or earlier. */
const sectionOf = c => isStale(c) ? 'earlier' : (c.status === 'busy' && !c.waiting) ? 'working' : 'needs'
let BFILTER = 'all'
/** The counts in the header, each one a filter: click to show only that section. */
function boardMeta (list) {
  const n = { all: list.length, needs: 0, working: 0, earlier: 0 }
  for (const c of list) n[sectionOf(c)]++
  const fresh = list.filter(c => sectionOf(c) === 'needs' && isNew(c)).length
  const bar = $('#bmeta')
  bar.replaceChildren()
  if (!list.length) return
  for (const [key, label] of [['all', 'All'], ['needs', 'Needs you'], ['working', 'Working'], ['earlier', 'Earlier']]) {
    if (key !== 'all' && !n[key]) continue
    const b = el('button', 'bfilter' + (BFILTER === key ? ' on' : ''))
    b.append(el('span', '', label), el('em', '', String(n[key])))
    if (key === 'needs' && fresh) b.appendChild(el('i', 'bfnew', `${fresh} new`))
    b.onclick = () => { BFILTER = BFILTER === key ? 'all' : key; $('#view-board').dataset.filter = BFILTER; boardMeta(list) }
    bar.appendChild(b)
  }
  $('#view-board').dataset.filter = BFILTER
}

function syncBoard (rows) {
  const live = new Map(rows.filter(r => r.live).map(r => [r.id, r.live]))
  for (const [id, x] of BCARDS) {
    const st = live.get(id)
    if (!st) { x.card.remove(); BCARDS.delete(id); continue }
    if (st !== x.data.status) {
      const c = { ...x.data, status: st }
      const card = boardCard(c)
      swapCard(x.card, card)
      BCARDS.set(id, { card, sig: x.sig.replace(/^[^|]*/, st), data: c })
    }
  }
  for (const id of STALE.keys()) if (!live.get(id)) STALE.delete(id)
  if ([...STALE.keys()].some(id => live.get(id) === 'busy')) send({ type: 'board' })
  boardMeta([...BCARDS.values()].map(x => x.data).concat([...STALE.values()]))
  const view = $('#view-board'), keepTop = view.scrollTop
  if (BCARDS.size) layoutBoard(BORDER.filter(id => BCARDS.has(id)))   // a swapped card's height may differ
  holdScroll(view, keepTop)
  if (!BCARDS.size && !STALE.size && !live.size) renderBoard([])
  // a chat from another window stays off the board, so it is not a reason to ask again
  if ([...live.keys()].some(id => !BCARDS.has(id) && !STALE.has(id) && !BOARD_ELSEWHERE.has(id))) send({ type: 'board' })
  else askBoard()                         // the replies themselves, a moment later
}

/**
 * Cards of different heights packed like a masonry wall: as many columns as
 * fit, each card dropped into the shortest one, newest first. A row-aligned
 * grid left a short reply sitting above a tall gap.
 */
// The order is kept as chat ids, not card nodes. A status flip swaps a card for
// a new one, and a kept node list then put the old card back on the next
// resize - two cards for one chat, one of them stuck on an older reply.
// 300px fits the shorter cards: at 380 a board just under 800px wide stayed
// in one column, leaving half the width empty
const BCOL_MIN = 300, BGAP = 14
let BORDER = []
function layoutBoard (ids) {
  BORDER = ids
  const cards = ids.map(id => BCARDS.get(id)?.card).filter(Boolean)
  const grid = $('#bgrid')
  const n = Math.max(1, Math.floor((grid.clientWidth + BGAP) / (BCOL_MIN + BGAP)))
  let cols = [...grid.querySelectorAll(':scope > .bcol')]
  if (cols.length !== n) {
    for (const c of cols) c.remove()
    cols = Array.from({ length: n }, () => grid.appendChild(el('div', 'bcol')))
  }
  // anything else in a column is a card no longer on the board
  const want = new Set(cards)
  for (const col of cols) for (const n of [...col.children]) if (!want.has(n)) n.remove()
  // work out where every card goes first, then touch only the columns that
  // differ: re-appending every card on every update moved the page under the
  // reader and threw their scroll back
  const h = cols.map(() => 0), plan = cols.map(() => [])
  for (const card of cards) {
    const k = h.indexOf(Math.min(...h))
    plan[k].push(card)
    h[k] += card.offsetHeight + BGAP
  }
  cols.forEach((col, k) => {
    const now = [...col.children]
    if (now.length !== plan[k].length || now.some((n, i) => n !== plan[k][i])) col.replaceChildren(...plan[k])
  })
}
// the column count follows the tab's width
new ResizeObserver(() => { if (BOARD_MODE && BORDER.length) keepTyping(() => layoutBoard(BORDER)) }).observe($('#bgrid'))

/**
 * The newest message rises to the top - but not under your hands. While you are
 * scrolling, or typing a reply into a card, the cards keep their places and
 * only their contents update; the moment you stop, the order catches up.
 * (Holding it for as long as you were scrolled down left a chat Claude had
 * just answered sitting where it was after a reply sent from further down.)
 */
let BOARD_SCROLLED_AT = 0, BOARD_OWN_SCROLL = false, BOARD_ORDER = [], BOARD_CATCHUP = 0
$('#view-board').addEventListener('scroll', () => {
  if (BOARD_OWN_SCROLL) { BOARD_OWN_SCROLL = false; return }   // the board putting you back, not you
  BOARD_SCROLLED_AT = Date.now()
}, { passive: true })
const boardReading = () => Date.now() - BOARD_SCROLLED_AT < 2500 ||
  !!document.activeElement?.classList?.contains('bcinput')
const holdScroll = (view, top) => { if (view.scrollTop !== top) { BOARD_OWN_SCROLL = true; view.scrollTop = top } }
/** Once you stop scrolling or typing, put the cards in their real order. */
function boardCatchUp () {
  clearTimeout(BOARD_CATCHUP)
  BOARD_CATCHUP = setTimeout(() => {
    if (boardReading()) return boardCatchUp()
    const want = BOARD_ORDER.filter(id => BCARDS.has(id))
    if (want.join() === BORDER.join()) return
    const view = $('#view-board'), top = view.scrollTop
    keepTyping(() => layoutBoard(want))
    holdScroll(view, top)
  }, 700)
}
document.addEventListener('focusout', e => { if (e.target.classList?.contains('bcinput')) boardCatchUp() })

const OLD_MS = 24 * 3600e3
const STALE = new Map()            // chats folded into one line: id -> its data
const UNFOLDED = new Set()         // folded chats opened back up to a full card
const isStale = c => c.status !== 'busy' && Date.now() - (c.replyTs || c.lastTs || 0) > OLD_MS

/** Chats left waiting more than a day, one line each under the cards; a click opens one up. */
function renderStale (list) {
  const wrap = $('#bold')
  STALE.clear()
  for (const c of list) STALE.set(c.id, c)
  if (!list.length) { wrap.replaceChildren(); return }
  const head = el('div', 'bsechead', `Earlier · waiting more than a day · ${list.length}`)
  const rows = [head]
  for (const c of list) {
    const row = el('div', 'bold-row')
    row.dataset.id = c.id
    const open = UNFOLDED.has(c.id)
    row.append(el('span', 'chev2', open ? '▾' : '▸'), sourceIcon(c.provider || 'claude'),
      el('span', 'boldtitle', c.title || '(untitled)'),
      el('span', 'boldage', c.replyTs ? ago(c.replyTs) + ' ago' : ''))
    const acts = el('div', 'bcacts')
    for (const [name, tip, fn] of [
      ['open', 'Open the whole chat', () => send({ type: 'openChat', id: c.id })],
      ['terminal', 'Go to its terminal', () => send({ type: 'resume', id: c.id, target: 'terminal' })]]) {
      const b = el('button', 'bcicon')
      b.appendChild(icon(name)); b.title = tip
      b.onclick = e => { e.stopPropagation(); fn() }
      acts.appendChild(b)
    }
    row.appendChild(acts)
    row.onclick = () => { open ? UNFOLDED.delete(c.id) : UNFOLDED.add(c.id); renderStale([...STALE.values()]) }
    rows.push(row)
    if (open) rows.push(boardCard(c))
  }
  wrap.replaceChildren(...rows)
}

function renderBoard (list) {
  const view = $('#view-board'), keepTop = view.scrollTop
  const grid = $('#bgrid')
  boardMeta(list)
  // what is happening now gets the cards; the rest folds into one line each
  const stale = list.filter(isStale)
  if (!document.querySelector('#bold .bcinput:focus')) renderStale(stale)
  list = list.filter(c => !isStale(c))
  $('#sec-needs').hidden = false
  if (!list.length) {
    for (const x of BCARDS.values()) x.card.remove()
    BCARDS.clear()
    BORDER = []
    $('#bwork').replaceChildren(); $('#sec-work').hidden = true
    $('#bneedsh').textContent = ''
    grid.replaceChildren(stale.length ? '' : el('div', 'empty', 'No chats are running. Start or resume one and it shows up here.'))
    return
  }
  grid.querySelector(':scope > .empty')?.remove()
  const keep = new Set(list.map(c => c.id))
  for (const [id, x] of BCARDS) if (!keep.has(id)) { x.card.remove(); BCARDS.delete(id) }
  // where every card sits now, so a card that moves up can glide there
  const before = new Map([...BCARDS].map(([id, x]) => { const r = x.card.getBoundingClientRect(); return [id, [r.left, r.top]] }))
  const order = []
  list.forEach((c, i) => {
    const sig = [c.status, c.replyTs, c.askTs, c.reply.length, c.context, c.title, c.waiting || '', c.doing].join('|')
    let x = BCARDS.get(c.id)
    if (!x || x.sig !== sig) {
      const card = boardCard(c)
      if (x) swapCard(x.card, card)
      x = { card, sig, data: c }
      BCARDS.set(c.id, x)
    } else {
      x.data = c
      x.card.querySelector('.bcstext').textContent = boardStatus(c)   // the clock moves on
    }
    order.push(c.id)
  })
  // working chats get slim cards of their own; the rest need you - approvals and
  // questions first, then new replies, then the ones already read
  const data = new Map(list.map(c => [c.id, c]))
  const working = order.filter(id => sectionOf(data.get(id)) === 'working')
  const rank = c => c.waiting ? 0 : isNew(c) ? 1 : 2
  const needs = order.filter(id => sectionOf(data.get(id)) === 'needs')
    .map((id, i) => [id, i]).sort((a, b) => rank(data.get(a[0])) - rank(data.get(b[0])) || a[1] - b[1]).map(x => x[0])
  const work = $('#bwork'), wantWork = working.map(id => BCARDS.get(id).card)
  if (work.children.length !== wantWork.length || wantWork.some((c, i) => work.children[i] !== c)) work.replaceChildren(...wantWork)
  $('#sec-work').hidden = !working.length
  $('#bworkh').textContent = working.length ? `Working · ${working.length}` : ''
  $('#sec-needs').hidden = !needs.length
  $('#bneedsh').textContent = needs.length ? `Needs you · ${needs.length}` : ''
  // while you scroll or type, the old order stands; a chat new to the board goes at the end
  BOARD_ORDER = needs
  const reading = boardReading()
  const placed = reading
    ? BORDER.filter(id => needs.includes(id)).concat(needs.filter(id => !BORDER.includes(id)))
    : needs
  layoutBoard(placed)
  holdScroll(view, keepTop)
  if (reading) boardCatchUp()
  paintSeen()
  // slide each moved card from its old place to its new one - no glow: with
  // chats working, something lit up every second
  for (const [id, x] of BCARDS) {
    const was = before.get(id)
    if (was === undefined) continue
    const now = x.card.getBoundingClientRect()
    const dx = was[0] - now.left, dy = was[1] - now.top
    if (dx || dy) {
      x.card.style.transition = 'none'
      x.card.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        x.card.style.transition = 'transform .35s ease'
        x.card.style.transform = ''
      })
    }
  }
  paintBoardRes()
}

if (BOARD_MODE) {
  document.body.classList.add('boardmode')
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-board'))
  send({ type: 'board' })
  setInterval(() => send({ type: 'board' }), 15000)   // the "2m ago" clocks, and a safety net
  // a chat stopped on an approval writes nothing, so nothing else would bring the
  // board round to it: while any chat is working, look again every few seconds
  setInterval(() => { if ([...BCARDS.values()].some(x => x.data.status === 'busy')) send({ type: 'board' }) }, 5000)
}

send({ type: 'ready' })
send({ type: 'trashed' })

// ---------------------------------------------------------------- settings
// The extension's own settings, in the panel rather than buried in the editor's
// settings editor. Every control writes the same VS Code setting the editor
// would, so the two never disagree.

// Everything the top strip can show. Codex reports its own quota inside its
// rollouts, so it is offered here even though Claude's comes from an endpoint.
const BARS = [
  { key: 'session', name: 'Claude 5h' },
  { key: 'weekly_all', name: 'Claude 7d' },
  { key: 'weekly_scoped', name: 'Top model 7d' },
  { key: 'codex_session', name: 'Codex 5h' },
  { key: 'codex_weekly', name: 'Codex 7d' },
]
const SWATCHES = ['#7fb069', '#5b8dd9', '#d9a441', '#c96a6a', '#8b6fd4', '#4fa8a8',
  '#d97757', '#8a8a8a']
const SLOTS = 3                       // the strip stays readable to about three

const setCfg = (key, value) => {
  CFG[key] = value
  send({ type: 'setSetting', key, value })
}

const el2 = (tag, cls, txt) => el(tag, cls, txt)

/** A styled on/off switch, rather than the platform's own checkbox. */
function switchEl (on, onChange) {
  const w = el('label', 'swrap')
  const i = el('input'); i.type = 'checkbox'; i.checked = on
  i.onchange = () => onChange(i.checked)
  w.append(i, el('i', 'sw'))
  return w
}

// ---------------------------------------------------------------- agents page
// Your chat history as tools for Claude and Codex: connecting them, and a log of
// every lookup they made - which agent, from which folder, read which chat or
// searched for what. Lookups are logged by the server, so this fills in live.
let ACTIVITY = null, ACT_HOST = null
function renderAgents () {
  const box = $('#agentsbody')
  box.replaceChildren()

  // the page's own heading, with the explanation one hover away
  const head = el('div', 'aghead')
  head.appendChild(el('h2', '', 'Chat history for your agents'))
  const info = el('button', 'aginfo')
  info.appendChild(icon('info'))
  info.setAttribute('aria-label', 'What this is')
  head.appendChild(info)
  box.appendChild(head)
  infoPopover(info)

  const card = (title, cls) => {
    const w = el('div', 'setcard ' + (cls || ''))
    if (title) w.appendChild(el('div', 'agcardtitle', title))
    box.appendChild(w)
    return w
  }
  const conn = card('Connected agents')
  MCP_HOST = el('div', 'mcpbody')
  conn.appendChild(MCP_HOST)
  if (MCP) paintMcp(); else send({ type: 'mcpStatus' })

  const log = card('Activity', 'actcard')
  ACT_HOST = el('div', 'actbody')
  log.appendChild(ACT_HOST)
  if (ACTIVITY) paintActivity()
  send({ type: 'mcpActivity' })
}

/** The ⓘ: what the feature is, what to ask, what it can and cannot see. */
function infoPopover (btn) {
  const pop = el('div', 'agpop')
  pop.hidden = true
  pop.innerHTML = `
    <p>Lets <b>Claude Code</b> and <b>Codex</b> look things up in the chats saved on this machine. They can read them, never change them.</p>
    <h4 data-ico="message">Try asking</h4>
    <ul>
      <li>"Open my most recent Codex chat and keep going"</li>
      <li>"What did we decide about the retry limit on Monday?"</li>
      <li>"Which chat edited README.md, and what changed?"</li>
      <li>"Find the chat where the deploy script failed"</li>
    </ul>
    <h4 data-ico="agent">What an agent can do</h4>
    <ul>
      <li>List recent chats, and search what was said in them</li>
      <li>Pull a chat's context: files changed, the first ask, the latest messages</li>
      <li>Find exact text anywhere, including command output</li>
      <li>See what a chat changed, down to the lines</li>
      <li>See which chats changed a file</li>
    </ul>
    <h4 data-ico="shield">Your control</h4>
    <ul>
      <li>Every lookup is logged below - which chat asked, and what it read</li>
      <li>"This project only" limits an agent to the folder it was started in</li>
      <li>Disconnect any time; a backup of each agent's settings is kept</li>
    </ul>`
  // an icon on each heading, so the three parts are told apart at a glance
  for (const h of pop.querySelectorAll('h4[data-ico]')) h.prepend(icon(h.dataset.ico, 'agpopico'))
  document.body.appendChild(pop)
  let hide = 0
  const show = () => {
    clearTimeout(hide)
    pop.hidden = false
    const b = btn.getBoundingClientRect()
    pop.style.top = `${b.bottom + 6}px`
    pop.style.left = `${Math.max(8, Math.min(b.left - 12, window.innerWidth - pop.offsetWidth - 8))}px`
  }
  const later = () => { hide = setTimeout(() => { pop.hidden = true }, 180) }
  btn.addEventListener('mouseenter', show)
  btn.addEventListener('mouseleave', later)
  btn.addEventListener('click', () => (pop.hidden ? show() : (pop.hidden = true)))
  pop.addEventListener('mouseenter', () => clearTimeout(hide))
  pop.addEventListener('mouseleave', later)
  // a page redraw drops the button; the popover goes with it
  new MutationObserver((_m, o) => { if (!btn.isConnected) { pop.remove(); o.disconnect() } })
    .observe($('#agentsbody'), { childList: true })
}

// each tool's icon, and the word its count reads as
const KIND = {
  recent_chats: ['list', 'chat list'], search_chats: ['find', 'search'], read_chat: ['eye', 'read'],
  find_text: ['scan', 'scan'], chat_edits: ['diff', 'diff'], file_history: ['history', 'file history'],
}
const CLIENTS = { 'claude-code': 'Claude Code', claude: 'Claude Code', codex: 'Codex', 'codex-mcp-client': 'Codex' }
// the name is whatever the connecting client says it is, so it is looked up as an own key and kept short
const clientName = c => Object.hasOwn(CLIENTS, c) ? CLIENTS[c]
  : typeof c === 'string' && c ? c.replace(/[-_]/g, ' ').slice(0, 40) : 'An agent'

/** One lookup as a sentence, with the chats it touched as links. */
function activitySentence (e) {
  const a = e.args || {}
  const q = x => `"${String(x).slice(0, 80)}"`
  const word = x => /^(claude|codex)$/.test(x) ? x : q(x)
  switch (e.tool) {
    case 'recent_chats': return 'listed recent chats' + (a.project ? ` in ${q(a.project)}` : '') + (a.provider ? ` from ${word(a.provider)}` : '')
    case 'search_chats': return `searched for ${q(a.query)}`
    case 'read_chat': return 'read the context of'
    case 'find_text': return `looked for ${q(a.text)} in transcripts and tool output`
    case 'chat_edits': return a.lines ? `read the edits${a.path ? ` to ${q(a.path)}` : ''} made by` : 'looked at what changed in'
    case 'file_history': return `asked which chats changed ${q(a.path)}`
    default: return `used ${e.tool}`
  }
}

/**
 * The log, one line per chat that asked: which chat, which agent, how many
 * lookups and when. Opening a line shows its lookups, one short line each, and
 * the chats a lookup found stay folded behind a count. Ten lines at first.
 */
const ACT_OPEN = new Set()
let ACT_SHOWN = 10
let ACT_WHO = 'all'   // which agent's lookups the log shows
function paintActivity () {
  const host = ACT_HOST
  if (!host || !host.isConnected || !ACTIVITY) return
  host.replaceChildren()
  if (!ACTIVITY.length) {
    host.appendChild(el('p', 'setnote', 'Nothing yet. Once an agent is connected, every chat it reads and every search it runs shows up here.'))
    return
  }
  // the week at a glance: how much, how many chats asked, how many were read
  const week = ACTIVITY.filter(e => Date.now() - e.ts < 7 * 864e5)
  const askers = new Set(week.map(e => e.from).filter(Boolean))
  const read = new Set(week.flatMap(e => (e.chats || []).filter(c => c.known).map(c => c.id)))
  const stats = el('div', 'actstats')
  for (const [n, label] of [[week.length, 'lookups this week'], [askers.size, askers.size === 1 ? 'chat asked' : 'chats asked'], [read.size, read.size === 1 ? 'chat read' : 'chats read']]) {
    const t = el('div', 'actstat')
    t.append(el('b', '', String(n)), el('span', '', label))
    stats.appendChild(t)
  }
  host.appendChild(stats)

  const bar = el('div', 'acttop')
  const kinds = [...new Set(ACTIVITY.map(e => clientName(e.client)))]
  if (kinds.length > 1) {
    const seg = el('div', 'actseg')
    for (const k of ['all', ...kinds]) {
      const b = el('button', ACT_WHO === k ? 'on' : '', k === 'all' ? 'All' : k)
      b.onclick = () => { ACT_WHO = k; paintActivity() }
      seg.appendChild(b)
    }
    bar.appendChild(seg)
  } else bar.appendChild(el('span'))
  const clear = el('button', 'actclear', 'Clear log')
  clear.onclick = () => send({ type: 'mcpClearActivity' })
  bar.appendChild(clear)
  host.appendChild(bar)
  const shown = ACT_WHO === 'all' ? ACTIVITY : ACTIVITY.filter(e => clientName(e.client) === ACT_WHO)

  // consecutive lookups from the same chat on the same day are one line
  const dayOf = ts => {
    const d = new Date(ts), today = new Date()
    const y = new Date(); y.setDate(today.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return 'Today'
    if (d.toDateString() === y.toDateString()) return 'Yesterday'
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  }
  const groups = []
  for (const e of shown) {
    const key = (e.from || `${e.client}|${e.cwd}`) + '|' + dayOf(e.ts)
    const g = groups[groups.length - 1]
    if (g && g.key === key) g.items.push(e)
    else groups.push({ key, day: dayOf(e.ts), items: [e] })
  }
  const time = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  let day = ''
  for (const g of groups.slice(0, ACT_SHOWN)) {
    if (g.day !== day) { day = g.day; host.appendChild(el('div', 'actday', g.day)) }
    const first = g.items[0], last = g.items[g.items.length - 1]
    const box = el('div', 'actgroup' + (ACT_OPEN.has(g.key) ? ' open' : ''))
    const head = el('button', 'acthead')
    const chev = el('span', 'chev2', ACT_OPEN.has(g.key) ? '⌄' : '›')
    const logo = sourceIcon(/codex/i.test(first.client) ? 'codex' : 'claude')
    const who = el('span', 'actfrom')
    if (first.from) {
      const name = el('span', 'actchat', first.fromTitle || first.from.slice(0, 8))
      name.title = first.fromKnown ? 'Open the chat that asked' : 'That chat is not on this machine any more'
      if (first.fromKnown) name.onclick = ev => { ev.stopPropagation(); $('.tab[data-tab="chats"]').click(); send({ type: 'session', id: first.from }) }
      who.appendChild(name)
    } else who.appendChild(el('span', 'actanon', 'Chat not known'))
    const n = g.items.length
    const span = first.ts === last.ts ? time(first.ts) : `${time(last.ts)}-${time(first.ts)}`
    // what kind of looking it did, in a few words
    const tally = {}
    for (const x of g.items) { const k = KIND[x.tool]?.[1] || 'other'; tally[k] = (tally[k] || 0) + 1 }
    const mix = Object.entries(tally).map(([k, c]) => `${c} ${c === 1 ? k : k + (k.endsWith('h') ? 'es' : 's')}`).join(' · ')
    const meta = el('span', 'actmeta', `${clientName(first.client)} · ${mix}`)
    const fails = g.items.filter(x => x.ok === false).length
    if (fails) meta.appendChild(el('span', 'actfail', ` · ${fails} failed`))
    const right = el('div', 'actright')
    right.append(el('span', 'actn', String(n)), el('span', 'acttime2', span))
    head.append(chev, logo, el('div', 'actheadtxt'), right)
    head.querySelector('.actheadtxt').append(who, meta)
    head.onclick = () => { ACT_OPEN.has(g.key) ? ACT_OPEN.delete(g.key) : ACT_OPEN.add(g.key); paintActivity() }
    box.appendChild(head)
    if (ACT_OPEN.has(g.key)) {
      const list = el('div', 'actlist')
      // a busy chat can make dozens: the latest ten, the rest on request
      const all = ACT_OPEN.has(g.key + '|all')
      for (const e of all ? g.items : g.items.slice(0, 10)) list.appendChild(activityLine(e))
      if (!all && g.items.length > 10) {
        const more = el('button', 'actmore', `Show all ${g.items.length}`)
        more.onclick = () => { ACT_OPEN.add(g.key + '|all'); paintActivity() }
        list.appendChild(more)
      }
      box.appendChild(list)
    }
    host.appendChild(box)
  }
  if (groups.length > ACT_SHOWN) {
    const more = el('button', 'actmore', `Show ${Math.min(10, groups.length - ACT_SHOWN)} more`)
    more.onclick = () => { ACT_SHOWN += 10; paintActivity() }
    host.appendChild(more)
  }
}

/** One lookup on one short line; the chats it found fold behind a count. */
function activityLine (e) {
  const row = el('div', 'actrow' + (e.ok === false ? ' failed' : ''))
  const line = el('div', 'actline')
  line.appendChild(el('span', 'acttime', new Date(e.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })))
  line.appendChild(icon(KIND[e.tool]?.[0] || 'dots', 'actico'))
  const what = el('span', 'actwhat', activitySentence(e))
  line.appendChild(what)
  const named = ['read_chat', 'chat_edits'].includes(e.tool)
  const found = (e.chats || []).filter(c => named || c.known)
  if (named) {
    const c = found[0]
    if (c) {
      const link = el('button', 'actchat', ' ' + c.title)
      link.title = c.known ? 'Open this chat' : 'Not on this machine any more'
      if (c.known) link.onclick = () => { $('.tab[data-tab="chats"]').click(); send({ type: 'session', id: c.id }) }
      what.appendChild(link)
    } else if (e.args?.id) what.append(` "${String(e.args.id).slice(0, 40)}"`)
  }
  if (e.ok === false) line.appendChild(el('span', 'actfail', 'failed'))
  row.appendChild(line)
  if (!named && found.length) {
    const toggle = el('button', 'actcount', `found ${found.length} chat${found.length === 1 ? '' : 's'}`)
    const chips = el('div', 'actchips')
    chips.hidden = true
    for (const c of found) {
      const link = el('button', 'actchat', c.title)
      link.onclick = () => { $('.tab[data-tab="chats"]').click(); send({ type: 'session', id: c.id }) }
      chips.appendChild(link)
    }
    toggle.onclick = () => { chips.hidden = !chips.hidden }
    line.appendChild(toggle)
    row.appendChild(chips)
  }
  return row
}

let MCP = null, MCP_HOST = null
/** One row per CLI: connected or not, and the button that changes it. */
function paintMcp () {
  const host = MCP_HOST
  if (!host || !host.isConnected || !MCP) return
  host.replaceChildren()
  const row = (key, name) => {
    const r = el('div', 'agrow')
    r.appendChild(sourceIcon(key))
    const txt = el('div', 'agrowtxt')
    txt.append(el('b', '', name), el('span', 'agstate' + (MCP[key] ? ' on' : ''), MCP[key] ? 'Connected' : 'Not connected'))
    const b = el('button', 'mcpbtn' + (MCP[key] ? '' : ' on'), MCP[key] ? 'Disconnect' : 'Connect')
    b.onclick = () => {
      b.disabled = true; b.textContent = MCP[key] ? 'Disconnecting…' : 'Connecting…'
      send({ type: MCP[key] ? 'mcpDisconnect' : 'mcpConnect', client: key, projectOnly: MCP.projectOnly })
    }
    r.append(txt, b)
    host.appendChild(r)
  }
  row('claude', 'Claude Code')
  row('codex', 'Codex')
  const r = el('div', 'agrow scope')
  const txt = el('div', 'agrowtxt')
  txt.append(el('b', '', 'This project only'), el('span', 'agstate', 'an agent sees only chats from the folder it was started in'))
  r.append(txt, switchEl(!!MCP.projectOnly, on => {
    MCP.projectOnly = on
    if (MCP.claude || MCP.codex) send({ type: 'mcpConnect', projectOnly: on })
  }))
  host.appendChild(r)
  if (MCP.claude || MCP.codex) host.appendChild(el('p', 'agnote', 'New chats pick this up. A chat that was already running needs a restart.'))
}

function renderSettings () {
  const box = $('#setbody')
  if (!box) return
  box.replaceChildren()

  // each group is a card: icon, title, a line on what it covers, then its rows
  const section = (ico, title, note, control) => {
    const w = el('div', 'setcard')
    const h = el('div', 'sechead')
    h.append(icon(ico, 'secico'), el('h3', '', title))
    if (control) h.appendChild(control)
    w.appendChild(h)
    if (note) w.appendChild(el('p', 'setnote', note))
    box.appendChild(w)
    return w
  }

  // --- the top strip, as numbered segments rather than a list of tickboxes
  const chosen = (Array.isArray(CFG.topBars) ? CFG.topBars : []).slice(0, SLOTS)
  const live = new Map((LIMITS?.items || []).map(x => [x.key, x]))

  const master = switchEl(chosen.length > 0, on => {
    setCfg('topBars', on
      ? [{ key: 'session', color: SWATCHES[0] }, { key: 'weekly_all', color: SWATCHES[1] }]
      : [])
    renderSettings(); drawLimits(LIMITS)
  })
  const sec = section('chart', 'Quota bars',
    'Bars along the top of the panel, one per usage window you pick, that shrink as you use it up. Point at one for exact figures.',
    master)

  if (chosen.length) {
    // a live preview, so the colours are chosen against the thing itself
    sec.appendChild(el('span', 'seclabel', 'Preview'))
    const pv = el('div', 'barpreview')
    for (const b of chosen) {
      const now = live.get(b.key)
      const left = now ? Math.max(0, 100 - now.percent) : 100
      const track = el('i', 'pvtrack')
      const fill = el('b')
      fill.style.width = `${left}%`
      fill.style.background = b.color || SWATCHES[0]
      track.appendChild(fill)
      pv.appendChild(track)
    }
    sec.appendChild(pv)

    sec.appendChild(el('span', 'seclabel', 'Segments'))
    chosen.forEach((b, i) => {
      const row = el('div', 'seg-row')
      const n = el('span', 'segnum', String(i + 1))
      n.style.background = b.color || SWATCHES[0]
      row.appendChild(n)

      const right = el('div', 'segright')
      const sel = el('select', 'segsel')
      for (const spec of BARS) {
        const now = live.get(spec.key)
        const o = el('option', '', spec.name + (now ? (now.stale ? ' · last known' : ` · ${Math.max(0, 100 - now.percent)}% left`) : ' · not reported'))
        o.value = spec.key
        if (spec.key === b.key) o.selected = true
        sel.appendChild(o)
      }
      sel.onchange = () => { chosen[i].key = sel.value; setCfg('topBars', chosen); renderSettings(); drawLimits(LIMITS) }
      right.appendChild(sel)

      const sws = el('div', 'swatches')
      for (const c of SWATCHES) {
        const d = el('button', 'swatch' + (c === (b.color || '') ? ' on' : ''))
        d.style.background = c
        d.title = c
        d.onclick = () => { chosen[i].color = c; setCfg('topBars', chosen); renderSettings(); drawLimits(LIMITS) }
        sws.appendChild(d)
      }
      right.appendChild(sws)
      row.appendChild(right)

      if (chosen.length > 1) {
        const rm = el('button', 'segdrop', '\u00d7')
        rm.title = 'Remove this segment'
        rm.onclick = () => { chosen.splice(i, 1); setCfg('topBars', chosen); renderSettings(); drawLimits(LIMITS) }
        row.appendChild(rm)
      }
      sec.appendChild(row)
    })

    if (chosen.length < SLOTS) {
      const add = el('button', 'segadd')
      add.append(icon('plus', 'segaddico'), el('span', '', 'Add a segment'))
      add.onclick = () => {
        const free = BARS.find(sp => !chosen.some(c => c.key === sp.key)) || BARS[0]
        chosen.push({ key: free.key, color: SWATCHES[chosen.length % SWATCHES.length] })
        setCfg('topBars', chosen); renderSettings(); drawLimits(LIMITS)
      }
      sec.appendChild(add)
    }
  }

  // --- the rest, the settings that already existed
  const pick = (host, key, label, note, options) => {
    const row = el('div', 'setrow')
    const txt = el('div', 'settxt')
    txt.append(el('b', '', label), el('em', '', note))
    const sel = el('select')
    for (const [value, name] of options) {
      const o = el('option', '', name); o.value = value
      if ((CFG[key] ?? options[0][0]) === value) o.selected = true
      sel.appendChild(o)
    }
    sel.onchange = () => setCfg(key, sel.value)
    row.append(txt, sel)
    host.appendChild(row)
  }
  const toggle = (host, key, label, note, dflt) => {
    const row = el('div', 'setrow')
    const txt = el('div', 'settxt')
    txt.append(el('b', '', label), el('em', '', note))
    row.append(txt, switchEl(CFG[key] ?? dflt, on => setCfg(key, on)))
    host.appendChild(row)
  }
  // a stepper rather than a number input: the platform's spinner arrows are the
  // one control that cannot be styled, and they looked pasted on
  const number = (host, key, label, note, dflt, min = 3, max = 200) => {
    const row = el('div', 'setrow')
    const txt = el('div', 'settxt')
    txt.append(el('b', '', label), el('em', '', note))
    const box = el('div', 'stepper')
    const clamp = n => Math.max(min, Math.min(max, n))
    let value = clamp(Number(CFG[key] ?? dflt) || dflt)
    const inp = el('input', 'stepval')
    inp.type = 'text'; inp.inputMode = 'numeric'; inp.value = String(value)
    const commit = n => {
      value = clamp(n)
      inp.value = String(value)
      setCfg(key, value)
    }
    const step = (by, sign) => {
      const b = el('button', 'stepbtn', sign)
      b.title = by > 0 ? 'More' : 'Fewer'
      b.onclick = () => commit(value + by)
      return b
    }
    inp.onchange = () => commit(Number(inp.value) || dflt)
    box.append(step(-1, '\u2212'), inp, step(1, '+'))
    row.append(txt, box)
    host.appendChild(row)
  }

  // --- where chats open: a picture of each layout, the way a window manager shows them.
  // Each shape is cells on a grid: [col, row, colSpan, rowSpan, isChat]
  const SHAPES = {
    panel: { cols: 1, rows: 3, cells: [[1, 1, 1, 2, 0], [1, 3, 1, 1, 1]], name: 'Bottom panel' },
    'panel-side': { cols: 2, rows: 3, cells: [[1, 1, 2, 2, 0], [1, 3, 1, 1, 1], [2, 3, 1, 1, 1]], name: 'Panel, side by side' },
    'panel-right': { cols: 3, rows: 2, cells: [[1, 1, 2, 2, 0], [3, 1, 1, 1, 1], [3, 2, 1, 1, 1]], name: 'Panel on the right' },
    'right-half': { cols: 2, rows: 1, cells: [[1, 1, 1, 1, 0], [2, 1, 1, 1, 1]], name: 'Right half' },
    'right-third': { cols: 3, rows: 1, cells: [[1, 1, 2, 1, 0], [3, 1, 1, 1, 1]], name: 'Right third' },
    'right-two-thirds': { cols: 3, rows: 1, cells: [[1, 1, 1, 1, 0], [2, 1, 2, 1, 1]], name: 'Right two thirds' },
    'bottom-half': { cols: 1, rows: 2, cells: [[1, 1, 1, 1, 0], [1, 2, 1, 1, 1]], name: 'Bottom half' },
    'bottom-third': { cols: 1, rows: 3, cells: [[1, 1, 1, 2, 0], [1, 3, 1, 1, 1]], name: 'Bottom third' },
    'right-stack': { cols: 2, rows: 2, cells: [[1, 1, 1, 2, 0], [2, 1, 1, 1, 1], [2, 2, 1, 1, 1]], name: 'Right stack' },
    grid: { cols: 2, rows: 2, cells: [[1, 1, 1, 1, 0], [2, 1, 1, 1, 1], [1, 2, 1, 1, 1], [2, 2, 1, 1, 1]], name: 'Grid of four' },
  }
  const alerts = section('bell', 'Use it or lose it',
    'Flags a quota bar you chose when it is about to reset with a lot left, or is on course to run out first - under the bars, on the live board and in the status bar.')
  toggle(alerts, 'limitAlerts', 'Also pop up a notification', 'once per window - the flag already shows here and in the status bar', false)
  number(alerts, 'resetSoonWeeklyHours', 'Weekly reset counts as soon', 'hours before it resets', 12, 1, 72)
  number(alerts, 'resetSoonSessionMinutes', '5-hour reset counts as soon', 'minutes before it resets', 30, 5, 180)
  number(alerts, 'unusedPercent', 'Flag it when this much is left', 'percent unused', 30, 5, 95)

  const boardSec = section('pulse', 'Live chats', 'The board of running chats, opened from the pulse icon.')
  toggle(boardSec, 'boardAllWindows', 'Chats from every window',
    "otherwise only the chats in this window's folders", false)
  toggle(boardSec, 'finishAlerts', 'Pop up when a chat finishes',
    'a count of chats waiting for you always shows in the status bar', false)
  const lay = section('layout', 'Chat layout',
    'Where a chat opens when you resume it or start a new one. Click one to make it the default.')
  const now = CFG.chatLayout || 'panel'
  const grid = el('div', 'laygrid')
  for (const [key, sh] of Object.entries(SHAPES)) {
    const b = el('button', 'laycard' + (key === now ? ' on' : ''))
    const pic = el('div', 'laypic' + (key.startsWith('panel') ? ' panel' : ''))
    pic.style.gridTemplateColumns = `repeat(${sh.cols}, 1fr)`
    pic.style.gridTemplateRows = `repeat(${sh.rows}, 1fr)`
    for (const [c, r, cs, rs, chat] of sh.cells) {
      const cell = el('i', chat ? 'chat' : 'code')
      cell.style.gridColumn = `${c} / span ${cs}`
      cell.style.gridRow = `${r} / span ${rs}`
      pic.appendChild(cell)
    }
    b.append(pic, el('span', '', sh.name))
    b.title = key === now ? 'Current default' : 'Use this for every chat'
    b.onclick = () => { setCfg('chatLayout', key); renderSettings() }
    grid.appendChild(b)
  }
  lay.appendChild(grid)
  if (now !== 'panel') {
    const arr = el('button', 'segadd')
    arr.append(icon('split', 'segaddico'), el('span', '', 'Arrange the chats open now'))
    arr.onclick = () => send({ type: 'arrange', layout: now })
    lay.appendChild(arr)
  }

  const listSec = section('list', 'The chat list', 'How chats are ordered and shown.')
  pick(listSec, 'sort', 'Order chats by', 'inside each folder', [
    ['recent', 'Most recent'], ['cost', 'Most expensive'],
    ['messages', 'Longest'], ['title', 'Title, A to Z']])
  toggle(listSec, 'showLiveFirst', 'Running chats first',
    'float anything running to the top', true)
  number(listSec, 'pageSize', 'Chats per folder', 'before "Show more"', 8)
  pick(listSec, 'dateFormat', 'Timestamps', '', [
    ['locale', 'Your computer\'s date style'], ['iso', 'Year first']])

  const resume = section('play', 'Resuming', 'Where a chat reopens when you pick it up again.')
  pick(resume, 'resumeTarget', 'Resume opens in', 'Codex chats always go to a terminal', [
    ['auto', 'Wherever it was first opened'], ['terminal', 'A terminal in the editor'],
    ['claude', 'The Claude Code extension'], ['desktop', 'Claude Desktop']])
  toggle(resume, 'skipPermissions', 'Skip permission prompts',
    'Claude runs every tool without asking first', false)

  const exp = section('export', 'Exporting', 'Where Export puts a chat, and what it writes there.')
  const dir = CFG.exportDirectory || ''
  const where = el('div', 'setrow')
  const wtxt = el('div', 'settxt')
  const shown = el('em', dir ? 'exportdir' : '', dir || 'not set - Export opens the chat as an unsaved tab you can save yourself')
  if (dir) shown.title = dir
  wtxt.append(el('b', '', 'Save exports to'), shown)
  const btns = el('div', 'exportbtns')
  const choose = el('button', 'mcpbtn' + (dir ? '' : ' on'), dir ? 'Change…' : 'Choose…')
  choose.onclick = () => send({ type: 'pickExportDir' })
  btns.appendChild(choose)
  if (dir) {
    const clear = el('button', 'mcpbtn', 'Clear')
    clear.title = 'Go back to opening exports as an unsaved tab'
    clear.onclick = () => send({ type: 'clearExportDir' })
    btns.appendChild(clear)
  }
  where.append(wtxt, btns)
  exp.appendChild(where)
  // the raw copy is only ever written to that folder, so it is offered once there is one
  if (dir) {
    toggle(exp, 'exportSourceCopy', 'Also write the raw transcript',
      'a .source.jsonl beside the markdown, with every tool result in full - secrets a tool printed included', false)
  }
}
