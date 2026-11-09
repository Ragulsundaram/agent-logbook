# Contributing to Agent Logbook

Thanks for helping. Bug reports, fixes and small features are all welcome.

## Run it from source

There is no build step and no dependencies.

```sh
git clone https://github.com/Ragulsundaram/agent-logbook.git
cd agent-logbook
code --extensionDevelopmentPath="$PWD"
```
Or open the folder in VS Code and press F5 (Run Extension).

That opens a new editor window with your copy of the extension loaded. After a
change, run **Developer: Reload Window** in that window to pick it up. Cursor and
other VS Code editors take the same flag.

You need real Claude Code or Codex chats in `~/.claude/projects` or
`~/.codex/sessions` to see anything in the panel.

## Where things live

| File | What it does |
|---|---|
| `extension.js` | Activation, commands, the panel host and messages to and from the webview |
| `scan.js` | Reading and parsing Claude and Codex transcripts |
| `search-worker.js`, `chat-worker.js` | Search and chat loading off the main thread |
| `mcp-server.js`, `mcp-setup.js` | The local MCP server that lets agents read your chat history |
| `media/` | The webview UI: the main panel (`body.html`, `main.js`, `style.css`), the single-chat panel (`session.*`) and the dashboard (`dashboard.*`) |

## Pull requests

- Using an AI coding agent? Point it at [AGENTS.md](AGENTS.md) first (Claude Code reads it through `CLAUDE.md` automatically). The same rules apply to people.

- Keep each one to a single change, and say in the description what you did and how you tested it.
- Issues labelled `good first issue` are a good place to start.
- Agent Logbook reads private transcripts. Never add code that sends their
  content off the machine, and never commit a real transcript as test data.

## Packaging

```sh
npx @vscode/vsce package
```

Releases to the VS Code Marketplace and Open VSX are done by the maintainer.

## Security

What the extension can access, and how changes are controlled: [SECURITY.md](SECURITY.md).

If you find a security problem, please don't open a public issue. Report it
privately through GitHub's **Report a vulnerability** button on the Security tab.