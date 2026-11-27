# Agent Logbook

Browse, read, resume and measure the Claude Code and Codex sessions already on
your machine. Everything is read from local transcript files. Nothing is
uploaded, and no account is needed.

**[Website](https://ragulsundaram.github.io/agent-logbook-site/)** · [Changelog](https://ragulsundaram.github.io/agent-logbook-site/changelog.html) · [Privacy](https://ragulsundaram.github.io/agent-logbook-site/privacy.html)

## What it does

**Read your chats.** Every session, grouped by project, with the full
conversation rendered the way you saw it: markdown, images, tool calls, and the
file diffs each edit made. Search across every transcript, not just titles.
A chat in this window that finished a reply you have not opened yet shows in
bold with a blue dot; hovering a row swaps its age for its actions.

**Find one fast.** Ctrl+Cmd+H (Ctrl+Alt+H on Windows and Linux), or "Agent
Logbook: Find a Chat…" in the Command Palette, opens a search box over every
chat, even with the sidebar closed. Running chats come first, then the rest under
Today, Yesterday and older headings, each with its agent's logo. Typing matches a
chat's title or folder, and from three letters on also finds chats that mention
the words, with the line that matched. Enter opens the chat in its
own tab; the button on a row opens it to the side. A Codex chat goes back to its
terminal.

**Pick one back up.** Resume opens the chat here in the logbook, with its
message box ready, by default. Settings can send it to a terminal, the Claude Code
extension or Claude Desktop instead, and Resume reveals the terminal already running it rather
than starting a second one. With chatting in the logbook turned off, or in a folder
you have not trusted, a chat goes back where it was started. Codex chats always resume in a terminal. "New chat from this one" forks a session with its
full history, like /branch; "New chat from a summary" starts a fresh one from a
written handover instead. A chat running elsewhere says where, with "Show
terminal" for a terminal in this window and "Continue here" once it is idle there;
"Continue here as a copy" in the chat's menu carries it on here while the original
keeps running.
Claude Desktop may title a resumed chat with its folder name or a generic title,
because its `claude://resume` link takes no title; rename the chat in Desktop if
you want it to match the Agent Logbook title.

**Chat from the logbook.** A box under every Claude chat lets you carry on
talking to it without a terminal: the reply streams in as it is written, and
file edits, commands, questions and plans wait for you as cards you approve,
deny or answer. The box holds your text, attachments (the first picture as a
thumbnail, later ones as chips in the sentence), the paperclip and one send button
(Queue while Claude is replying, Stop when the box is empty). The quiet line under
it shows the chat's details on the left and, on the right, the model with its
effort and the permission mode: click either to pick for this chat (Shift+Tab in
the box switches the mode for that chat only; new chats start on the last one picked
from the menu). Stop a
reply with Escape, paste or drop in pictures, PDFs and text files and use slash
commands. To drop files from Finder or the Explorer, hold Shift while dragging them
onto the chat: without it, the editor opens the file instead (this is how VS Code
and Cursor hand drags to extension views, in the sidebar and in tabs alike). `/mcp` lists the
chat's MCP servers and, as in the terminal, can turn one off or on for the
folder, reconnect one that failed, or sign in to one. The + button starts a
new chat here or in a terminal. This runs your own installed Claude Code in the
background (`claude -p` with streaming input and output), so your login,
settings, MCP servers and CLAUDE.md apply as usual, and it writes the same
transcript a terminal would. A chat already running in a terminal or another
app is never written to twice; it can be continued here as a copy instead.
Turn **Chat here** off in Settings to keep the logbook read-only, as before.
Chatting needs a trusted folder: Claude runs without its own folder-trust
prompt here, and would load the folder's settings, hooks and MCP servers. The
window must be trusted (in Restricted Mode the box stays off; reading chats
still works), and a chat's folder must be one of the window's folders, or one
you have already trusted in Claude itself.
When a chat belongs to one of the window's folders, Claude may also work in the
window's other folders, as with a multi-root workspace in the terminal; a chat
from elsewhere gets only its own folder. The chat settings are yours alone: a
folder's own settings file cannot change them.

**See the sub-agents.** Background agents keep their own transcripts. Each one
appears as a card where it was launched, with the brief it was given and what it
reported, and opens as its own readable thread. Nested agents are shown as a
tree, since an agent can spawn its own. While a chat here has agents or commands
running in the background, the strip above the message box lists them: Open
shows an agent's steps as its thread, and Output shows what a command printed.

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
sent anywhere else. A file you drop on the message box from VS Code's Explorer is
read only to attach it to your message, as the attach button would; files inside
`~/.claude`, `~/.codex` or `~/.claude.json`, which hold logins and settings, are
never read this way.

**Writes** its own cache and flags under `~/.claude`, and appends a
`custom-title` line to a Claude transcript when you rename a chat, which is how
Claude Code reads the new name back. Renaming a Codex chat writes nothing to the
transcript. Deleting a chat moves the file to `~/.claude/trashed-sessions`
rather than unlinking it.
Chatting from the logbook keeps two small things under `~/.agent-logbook`:
`cutoff.json`, the chats whose reply a window reload cut off (so they can offer
Continue, cleared after two days), and `pastes/`, pictures pasted into an answer
to one of Claude's questions, saved as files so Claude can open them and deleted
after a week.

**Runs** your own `claude` CLI when you send a message from the logbook. Claude
Code does the work exactly as it would in a terminal - its own network
requests, file edits and transcript writes, each edit or command approved by
you unless you chose a mode that skips asking ("Always allow" on an approval
saves the rule Claude suggests to its own settings, as the terminal's "don't ask
again" does). The extension itself sends
nothing to the network for this; it only talks to that local process. A message
you type starting with `!` runs in your own shell in the chat's folder, as it
would in a terminal, and Claude gets the command and its output with your next
message. So that "/" lists your slash commands straight away, a few seconds
after a window opens it also starts `claude` once in your home folder to ask
for them and lets it go: no message is sent, no chat is saved, and it runs no
hooks, no MCP servers and no settings from the folder you opened. The list is
kept in the editor's own extension storage until the next one.
As in Claude's own editor panel, a message you send from the logbook also tells
Claude which file you have open and the lines you have selected (the line above
the box shows what goes, with Leave out for one message, and
`claudeHistory.chatEditorContext` turns it off). Before Claude edits a
file you have open with unsaved changes, the logbook saves it (reading one
never saves it; Claude reads what is on disk), and after an
edit it passes on any new errors the editor reports in that file. Files you
attach go to Claude with the message: PDFs as they are, text files as their text.
What counts as a text file goes by its extension (Markdown, code, JSON, CSV, logs
and the like), the same whether it is attached, pasted or dropped; `.env` files
are not attached, as they usually hold secrets.
A message carries up to 8 pictures and 8 files; anything past that is named in a
note rather than dropped silently.

## Settings

The Settings tab covers the quota bars across the top of the panel - which
windows they show, in what order, in what colour - along with list ordering,
where Resume opens, and what an export contains. Every control writes the same
setting the editor's own settings page does.

**Footer** picks what the line under a chat's message box shows
(`claudeHistory.footerItems`): the activity graph, context in use, cache share,
cost, reply time ("Done in…") and files changed. Context and cost are on by
default. Files changed is a link that opens the chat's list of changed files; the
list is also in the chat's menu (the … on its title row), and a chat without that
menu always shows the link. A chat using a lot of memory or processor adds a
"Laptop" figure to the line, whatever is picked.

## Contributing

The source is on [GitHub](https://github.com/Ragulsundaram/agent-logbook).
Issues and pull requests are welcome. See
[CONTRIBUTING.md](https://github.com/Ragulsundaram/agent-logbook/blob/main/CONTRIBUTING.md)
to run it from source.

## Licence

MIT.
