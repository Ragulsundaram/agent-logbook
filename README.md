# Agent Logbook

Browse, read, resume and measure the Claude Code and Codex sessions already on
your machine. Everything is read from local transcript files. Nothing is
uploaded, and no account is needed.

**[Website](https://ragulsundaram.github.io/agent-logbook-site/)** · [Changelog](https://ragulsundaram.github.io/agent-logbook-site/changelog.html) · [Privacy](https://ragulsundaram.github.io/agent-logbook-site/privacy.html)

## What it does

**Read your chats.** Every session, grouped by project, with the full
conversation rendered the way you saw it: markdown, images, tool calls, and the
file diffs each edit made. Search across every transcript, not just titles.

**Pick one back up.** Resume opens the chat in a terminal, the Claude Code
extension or Claude Desktop, and reveals the terminal already running it rather
than starting a second one. Branch forks a session with its full context;
Branch with a brief starts a fresh one from a written handover instead.
Claude Desktop may title a resumed chat with its folder name or a generic title,
because its `claude://resume` link takes no title; rename the chat in Desktop if
you want it to match the Agent Logbook title.

**Chat from the logbook.** A box under every Claude chat lets you carry on
talking to it without a terminal: the reply streams in as it is written, and
file edits, commands, questions and plans wait for you as cards you approve,
deny or answer. Pick the model, effort and permission mode per chat, stop a
reply with Escape, paste images and use slash commands. The + button starts a
new chat here or in a terminal. This runs your own installed Claude Code in the
background (`claude -p` with streaming input and output), so your login,
settings, MCP servers and CLAUDE.md apply as usual, and it writes the same
transcript a terminal would. A chat already running in a terminal or another
app is never written to twice; it can be continued here as a copy instead.

**See the sub-agents.** Background agents keep their own transcripts. Each one
appears as a card where it was launched, with the brief it was given and what it
reported, and opens as its own readable thread. Nested agents are shown as a
tree, since an agent can spawn its own.

**Know what it cost.** A dashboard over your whole history - tokens, spend,
cache efficiency, models, projects, files, working hours - plus per-chat stats
including context growth and prompt-cache expiry. A shareable PNG card
summarises a day, a week or all of it.

**Codex too.** Codex sessions are listed, read, searched and resumed alongside
Claude's. Rollouts that are imported copies of Claude transcripts are skipped
rather than counted twice.

## Requirements

- VS Code 1.94 or later, or any editor built on it - Cursor, Windsurf, VSCodium
  and the rest.
- `claude` on your `PATH` to resume Claude sessions, `codex` for Codex ones.
- Plan-usage bars use the credentials Claude Code already stores: the macOS
  Keychain, or `~/.claude/.credentials.json` on Linux and Windows.

Copying the share card to the clipboard needs `wl-copy` or `xclip` on Linux;
Save PNG works everywhere.

## What it reads and writes

It is worth being explicit, because two of these would look alarming if you
found them rather than read them here.

**Reads** `~/.claude/projects` and `~/.codex/sessions` for transcripts,
`~/.claude/**/memory` and `~/.codex/memories` for notes, and your Claude OAuth
token from where Claude Code keeps it (the macOS Keychain, or its credentials file elsewhere) so it can ask Anthropic for your current plan
usage - the same request Claude Code itself makes. The token is never stored or
sent anywhere else.

**Writes** its own cache and flags under `~/.claude`, and appends a
`custom-title` line to a Claude transcript when you rename a chat, which is how
Claude Code reads the new name back. Renaming a Codex chat writes nothing to the
transcript. Deleting a chat moves the file to `~/.claude/trashed-sessions`
rather than unlinking it.

**Runs** your own `claude` CLI when you send a message from the logbook. Claude
Code does the work exactly as it would in a terminal - its own network
requests, file edits and transcript writes, each edit or command approved by
you unless you chose a mode that skips asking. The extension itself sends
nothing to the network for this; it only talks to that local process.

## Settings

The Settings tab covers the quota bars across the top of the panel - which
windows they show, in what order, in what colour - along with list ordering,
where Resume opens, and what an export contains. Every control writes the same
setting the editor's own settings page does.

## Contributing

The source is on [GitHub](https://github.com/Ragulsundaram/agent-logbook).
Issues and pull requests are welcome. See
[CONTRIBUTING.md](https://github.com/Ragulsundaram/agent-logbook/blob/main/CONTRIBUTING.md)
to run it from source.

## Licence

MIT.
