# Instructions for AI coding agents

You are changing Agent Logbook, a VS Code extension that reads people's private
Claude Code and Codex transcripts. Read this whole file before writing code.
Humans: see CONTRIBUTING.md.

## Scope

- Work on one issue per pull request. Change only what that issue needs.
- Do not reformat, rename or "tidy" code you were not asked to touch.
- If the issue is unclear, ask in the issue before writing code.
- If an issue asks for a file (for example `.vscode/launch.json`), the PR must
  contain that file. Check `git status` before you commit.

## Hard rules (a PR that breaks one is closed)

1. **No dependencies.** Do not add `dependencies`, `devDependencies`, install
   scripts, a bundler or a build step. Use Node's standard library
   (`require('node:fs')`) and the `vscode` API.
2. **No new network calls.** The only request the extension makes is the
   plan-usage call to `api.anthropic.com` in `scan.js`. Do not add `fetch`,
   `node:http(s)`, WebSockets, telemetry, analytics or remote fonts/scripts.
   Running the user's own `claude` CLI is not a network call by the
   extension: `chat-runner.js` (chatting from the logbook) and the handover
   brief do this, and Claude Code makes its own requests as it always does.
3. **Transcripts never leave the machine** through the extension, and are never
   committed. Do not add real transcripts, `.jsonl` files or screenshots of real
   chats as test data. Make up small fake samples if you need them.
4. **No shell strings.** Run programs with `execFile` / `execFileSync` and an
   argument array, never `exec` or `shell: true`. Anything sent to a terminal
   with `sendText` must be built from validated values (ids, known commands),
   never from raw text out of a transcript.
   The one exception is shell mode in the message box: a message the user types
   starting with `!` runs in their login shell in the chat's folder
   (`chatShell` in `extension.js`), as it would in a terminal. Only that typed
   text may be run this way, never text from a transcript, from Claude or from
   any other source.
5. **Escape everything shown in a webview.** Use the `esc()` helper in
   `media/*.js` or `textContent`. Never put transcript text into `innerHTML`
   unescaped. Keep the Content-Security-Policy and nonce in `extension.js` as
   they are; do not add `unsafe-eval` or outside sources.
6. **Writes stay where they are documented** in README.md ("What it reads and
   writes"). A change that writes somewhere new must update that section.

## Code style

Match the file you are in:

- CommonJS (`require`), 2-space indent, single quotes, no semicolons, a space
  before function parentheses (`function openSession (ctx, id)`).
- Comments explain *why*, in plain sentences. No commented-out code.
- Settings live under the `claudeHistory.` prefix in `package.json`.
- User-facing text is short, plain English, no emoji.

## Where things are

| File | What it does |
|---|---|
| `extension.js` | Activation, commands, panel host, messages to and from the webview |
| `scan.js` | Reads and parses Claude and Codex transcripts; the usage request |
| `search-worker.js`, `chat-worker.js` | Search and chat loading off the main thread |
| `chat-runner.js` | Chatting from the logbook: runs `claude -p` with stream-json and relays replies and permission prompts |
| `mcp-server.js`, `mcp-setup.js` | The local MCP server agents use to read chat history |
| `media/` | Webview UI: `body.html` + `main.js` + `chat.js` + `style.css` (main panel), `session.*`, `dashboard.*` |

## Before you open the pull request

```sh
for f in *.js media/*.js; do node --check "$f" || exit 1; done
node .github/check.js origin/main   # the same source rules CI runs
code --extensionDevelopmentPath="$PWD"   # then try the change by hand
```

- Fill in every part of the pull request template, including how you tested.
- Do not edit `CHANGELOG.md` or the version in `package.json`; the maintainer
  does that at release time.
- Say in the PR description that an AI agent wrote or helped write the change.
  That is welcome; hiding it is not.
