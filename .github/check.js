// Source checks for every PR and push. Run locally with: node .github/check.js [base-ref]
// Fails on patterns that are never allowed (AGENTS.md hard rules). Flags, without
// failing, changes that need a careful human read.
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' })
const files = git('ls-files', '*.js', 'media/*.js', 'media/*.html').split('\n').filter(f => f && !f.startsWith('.github/'))
const errors = []
const flags = []

const RULES = [
  [/node:https?['"]|require\(\s*['"]https?['"]\s*\)|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|EventSource\s*\(/, 'network access (AGENTS.md rule 2)', f => f !== 'scan.js'],
  [/require\(\s*['"](node:)?(net|tls|dgram|dns|http2|vm|inspector)['"]\s*\)/, 'network or code-running module (AGENTS.md rule 2)'],
  [/\b(globalThis|window|self|global)\s*\[/, 'computed global lookup (hides what is called)'],
  [/['"](curl|wget|nc|ncat|ssh|scp|ftp|telnet)['"]/, 'runs a network program (AGENTS.md rule 2)'],
  [/\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/, 'runs code from a string'],
  [/\brequire\s*\(\s*(?!['"][^'"]+['"]\s*\))/, 'require of a computed name'],
  [/\bimport\s*\(/, 'dynamic import()'],
  // exec from child_process, not RegExp#exec
  [/\{[^}]*\bexec(Sync)?\b[^}]*\}\s*=\s*require\(\s*['"](node:)?child_process|child_process['"]\s*\)\s*\.exec(Sync)?\b|shell\s*:\s*(true|['"`])/, 'shell command string (AGENTS.md rule 4)'],
  [/[A-Za-z0-9+/]{200,}={0,2}/, 'long encoded blob']
]

for (const f of files) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const [rx, why, applies] of RULES) {
      if ((!applies || applies(f)) && rx.test(line)) errors.push(`${f}:${i + 1}: ${why}`)
    }
  })
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'bundleDependencies']) {
  if (pkg[k] && Object.keys(pkg[k]).length) errors.push(`package.json: ${k} not allowed (AGENTS.md rule 1)`)
}
for (const k of Object.keys(pkg.scripts || {})) {
  if (/install|prepare|prepack|postpack/.test(k)) errors.push(`package.json: script "${k}" not allowed (AGENTS.md rule 1)`)
}
for (const f of git('ls-files', '*.jsonl').split('\n').filter(Boolean)) errors.push(`${f}: transcript committed (AGENTS.md rule 3)`)

// What changed since the base: sensitive files and new long lines get flagged.
const base = process.argv[2]
if (base) {
  const SENSITIVE = /^(scan\.js|mcp-server\.js|mcp-setup\.js|extension\.js|package\.json|\.vscodeignore|\.github\/.*|AGENTS\.md|CLAUDE\.md)$/
  for (const f of git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean)) {
    if (SENSITIVE.test(f)) flags.push(`${f}: sensitive file changed, read every line`)
  }
  let file = '', hunkFn = ''
  for (const line of git('diff', '--unified=0', `${base}...HEAD`).split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(6)
    // git names the function each change sits in after the hunk's second @@
    else if (line.startsWith('@@')) hunkFn = line.replace(/^@@[^@]*@@ ?/, '')
    // The clipboard and PATH code already starts shells; a PR may not add another.
    // The one allowed exception is shell mode in the message box (chatShell in
    // extension.js), which runs only what the user typed after "!" - matched on
    // its exact line, so any other shell still fails.
    else if (line.startsWith('+') && /\.js$/.test(file) && /['"](\/bin\/)?(sh|bash|zsh|dash|fish|powershell|pwsh|cmd|cmd\.exe)['"]|process\.env\.SHELL/.test(line) &&
      !(file === 'extension.js' && /^function chatShell \(/.test(hunkFn) && /^\+  const sh = process\.env\.SHELL \|\| '\/bin\/zsh'$/.test(line))) errors.push(`${file}: new line starts a shell (AGENTS.md rule 4)`)
    else if (line.startsWith('+') && line.length > 300 && !/<svg|'M[\d.\s,-]/.test(line)) flags.push(`${file}: new line of ${line.length - 1} characters, check it is not hidden code`)
    // Allowed in the code today, but a new use needs a human to read where its input comes from.
    else if (line.startsWith('+') && /openExternal|Uri\.parse|execFile|spawn\s*\(|new\s+Worker|writeFile|sendText|innerHTML|outerHTML|insertAdjacentHTML/.test(line)) flags.push(`${file}: new ${line.match(/openExternal|Uri\.parse|execFile|spawn|Worker|writeFile|sendText|innerHTML|outerHTML|insertAdjacentHTML/)[0]} call, check what feeds it`)
  }
}

const out = process.env.GITHUB_STEP_SUMMARY
const say = s => { console.log(s); if (out) fs.appendFileSync(out, s + '\n') }
for (const f of flags) console.log(`::warning::${f}`)
for (const e of errors) console.log(`::error::${e}`)
say(`## Source check\n\n${errors.length} problem(s), ${flags.length} flag(s) for review.\n`)
for (const e of errors) say(`- ❌ ${e}`)
for (const f of flags) say(`- ⚠️ ${f}`)
process.exit(errors.length ? 1 : 0)
