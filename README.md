# Agent Logbook

<img src="media/icon.png" width="96" alt="">

Browse, read, resume and measure the Claude Code and Codex sessions already on
your machine. Everything is read from local transcript files. Nothing is
uploaded, and no account is needed.

## What it does

**Read your chats.** Every session, grouped by project, with the full
conversation rendered the way you saw it: markdown, images, tool calls, and the
file diffs each edit made. Search across every transcript, not just titles.

**Pick one back up.** Resume opens the chat in a terminal, the Claude Code
extension or Claude Desktop, and reveals the terminal already running it rather
than starting a second one. Branch forks a session with its full context;
Branch with a brief starts a fresh one from a written handover instead.

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

## Settings

The Settings tab covers the quota bars across the top of the panel - which
windows they show, in what order, in what colour - along with list ordering,
where Resume opens, and what an export contains. Every control writes the same
setting the editor's own settings page does.

## Licence

MIT.

## Install

Search for **Agent Logbook** in the Extensions panel of Cursor, Windsurf,
VSCodium or any editor that uses Open VSX, or install it from
[open-vsx.org/extension/ragulsundaram/agent-logbook](https://open-vsx.org/extension/ragulsundaram/agent-logbook).

## Bugs and ideas

[Open an issue](https://github.com/Ragulsundaram/agent-logbook/issues/new/choose).
