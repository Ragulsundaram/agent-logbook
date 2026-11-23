# Changelog

## 1.11.1

- Copying from a chat works like a browser's copy: Slack, Notion, Docs and email keep the bold, italics, links and numbered lists, and a plain text box gets clean words without ** or other Markdown marks.

## 1.11.0

- A chat that is idle in a terminal or another app can be continued here, not only as a copy. Its Claude is stopped first, and only once it is checked to be idle.
- Running chats pick up changes to your MCP servers, and /mcp, /btw and /thinking work on an older chat before you send it anything.
- Chatting from the logbook needs a trusted folder. In Restricted Mode the message box stays off and reading chats still works, and a chat's folder must be one of the window's folders or one you already trusted in Claude.
- The chat settings are yours alone: a folder's own settings file cannot change them. Claude asks before saving a file outside the chat's folders.
- Menus stay open while Claude is replying, and scrolling up no longer gets pulled back down. Chats running here no longer show the walking figure or a gap.
- The usage notice shows once per chat.
- Improved security.

## 1.10.0

- Background commands and agents each get a card while they run, working or not: Output shows what a command printed or the steps an agent has taken so far, and Stop ends just that one. An agent's card says what it is doing now. An agent's report shows as one line with the report folded under it.
- Working and done come from Claude itself, so a chat no longer sticks on "working". One Esc stops the reply and the turns queued behind it, and a queued message can be taken back.
- The status line says what is happening: the command or file a step is on, compacting, retrying after an error, hooks running, or thinking with a token count. A sub-agent's current step and Claude's thinking show under it.
- Claude sees the file you have open and the lines you have selected, saved first if they had unsaved changes, and hears about new errors after its edits. Approvals can open the change in the editor's diff view, and Deny and stop ends the reply.
- Attach PDFs and text files as well as pictures, and @ picks a file from the chat's folder.
- Commands, searches and web fetches show what they printed, any step that fails shows its error, and a failed step says so on the folded line. Edits you deny, or that fail, no longer count as changes.
- Claude's to-do list, /btw for a side question, /thinking, /mcp, and effort changes without a restart. Notices for usage limits, a model switch, an expired sign-in or new terms, and the auto mode "keep going?" question. A pop-up when Claude asks something while you are looking elsewhere.
- /clear carries on in the fresh chat, and new skills appear in / without a reload. A message starting with ! turns the box into a shell command.

## 1.9.0

- Chat with Claude right in the logbook. Every Claude chat has a message box under it, and + starts a new chat here. Claude's replies stream in as they are written, with the same status line as the terminal: what it is doing, for how long, and Esc to stop. On by default; turn it off in Settings to keep the logbook read-only.
- Approvals, questions and plans appear as cards above the box. Pictures can be pasted into a message, and into an answer to a question.
- The box works like Claude Code's: / lists commands, /model and /effort change the model and effort, Shift+Tab switches the mode, Up brings back earlier messages, and a message starting with ! runs as a shell command whose output Claude gets with your next message. Messages sent while Claude is working queue up behind the reply.
- New chats start on the mode and effort you picked last.
- Open a chat in its own editor tab, from its menu, the list's right-click menu, or Alt-click for a split, and keep several side by side. Tabs show whether their chat is working or waiting on you, and come back after a restart.
- A chat running in a terminal or another app says where, with Show it for a terminal in this window, or continues here as a new chat with its full history.
- A chat waiting on background agents or commands stays marked as working until Claude has taken their results up, and an agent's report shows as one line with the report folded under it.
- If a window reload or close cuts off a reply, the chat says so and offers Continue.
- A tidier chat view: the chat's actions sit in one menu on the title row, cost shows once as an estimate at API prices, context shows as a percentage, and the laptop's memory and CPU appear only when a chat is using a lot.
- Faster and steadier: live updates redraw only what changed, the running-chats check slows down while the panel is hidden, and the chat list refreshes in a fraction of the time.
- Fix: scrolling up while Claude is writing no longer pulls you back to the end.
- Fix: more chats load from a folder's Show more button, not by scrolling near it.

## 1.8.0

- The live board is redesigned into Needs you, Working and Earlier sections, with counts on the filters and shorter, calmer cards. Codex chats show there too.
- Reply to a chat from its card. When Claude asks a question, it moves to the top of the card with the whole paragraph it ends, and one-tap replies appear when the chat's last reply makes the options clear.
- Working cards say what they are doing, approvals and questions stand out, new replies are marked and read ones dim. The status bar counts chats that finish.
- The board holds still while you scroll or type, then re-sorts as soon as you stop, so a chat Claude just answered moves up. Chats waiting more than a day fold into one line.
- Search never hangs: a stuck search ends with what it found and a note to retry.
- Fix: message search with capital letters in the query no longer drops answers.
- The source is now on GitHub, and contributions are welcome.

## 1.7.0

- Chats open faster. They load in the background, so a click never waits behind a long chat. Long chats show their latest messages first and the rest slots in underneath without redrawing, and a chat you already read only reads what was added since.
- The chat header and each agent show the model. Running agents are timed up to now, and the header numbers stay live.
- Plan limit countdowns tick on their own, and a limit that has reset drops its warning.
- The header row fits narrow panels: the view name shortens, then hides, and the tools wrap together instead of being cut off.
- The folders open in this window start expanded and other folders start collapsed, so the list shows this project's chats first. A search still opens every folder.
- Numbered lists keep counting across blank lines, so copies paste into Slack as 1, 2, 3. Lines starting with • show as a bulleted list.
- Fix: a chat whose first quick read began at a screenshot now opens, and clicking it again while it loads no longer starts a second read.

## 1.6.0

- Chat report: a chat's stats open as a report that starts with where the money went, by model and by kind of token, then shows how full the context got, what breaks cost once the cache went cold, the chat's pace, how Claude worked, the tools it ran, the agents it started and the files it edited.
- The dashboard is grouped into Spend, Chats, Projects & files, Tokens & models, When you work and Plan limits.
- The agent tools have plainer names: recent_chats, search_chats, read_chat, find_text, chat_edits and file_history. A connected Claude Code picks up the updated skill the next time the editor starts, with nothing to reconnect.
- A Deleted chip lists chats you deleted and restores any of them to its original folder.
- Message search can show more than the first 60 chats.
- An open chat keeps updating when the file watcher goes quiet, and Refresh redraws it too.
- Clearer wording in Settings, on the share card and in the Agents page examples.

## 1.5.0

- Chat history for your agents: one click in Settings connects Claude Code and Codex to a local, read-only server over your chats. They can list and search past chats, pull a chat's context to continue its work, find exact strings in tool output, see what a chat changed (summary or diff) and which chats changed a file. Optionally limited to the current project. A skill lets you just ask in plain words.
- Settings › Exporting has a folder picker for where exports are saved. Until one is chosen, Export opens the chat as an unsaved tab, as before.
- The raw .source.jsonl copy beside an export is now off by default, and only offered once an export folder is set.
- Improved security.
- Fix: chats on models Claude Code runs at 1M by default (Opus 4.7 and up, Sonnet 5 and 5.5, Haiku 5.5, Fable, Mythos) show the 1M window from the start. Claude Code writes these model ids without a [1m] tag, so the 1.4.x check never fired and the meter read 200K until a chat passed it. Opus 4.6, Sonnet 4.6 and Haiku 4.5 stay at 200K unless run with [1m].

## 1.4.2

- Fix: right-clicking in a message now opens a menu that copies. Copy copies the selected text, Copy link and Copy path copy the link or path under the pointer, Copy code copies a code block, and Copy message copies the whole message. Before, the menu only showed a greyed-out Copy unless text was selected.

## 1.4.1

- Folders are ordered by their latest chat instead of by how many chats they hold, so a folder with today's chats no longer sits below one full of old ones.
- In a workspace with several folders, every one of them counts as current and stays at the top, the most recently active first.
- Clicking a file path shows it in Finder by asking macOS directly. Before, the editor's own command could open the file in a tab instead. Cmd/Ctrl-click still opens it in the editor.
- More file names are clickable: zip, tar, dmg, vsix and other archives, Office files, and audio and video files.
- A relative path is looked up in every folder of the workspace, not only the first.

## 1.4.0

- Links and file paths in messages are clickable. A web address opens in your browser. A file path shows the file in Finder, or opens it in the editor with Cmd/Ctrl held; a folder opens in Finder.
- A dismissed usage warning comes back instead of staying gone for the whole window: when the time it warned about has halved, when it gets more serious (unused, then running out), or when a new window starts. Dismissing it in the sidebar also hides it in Live chats, and the other way round.
- The sidebar is titled Agent Logbook instead of History.
- Fix: the folder this window is open on stays at the top of the list after you add a chat to a group or open Settings, instead of dropping below busier folders.

## 1.3.2

- The store pages and README link to the new website, its changelog and the privacy page.

## 1.3.1

- Live chats shows the chats in this window's folders by default, with a switch in the Settings tab to show every window.
- New setting: open Agent Logbook in the sidebar when the editor starts, instead of the Explorer (off by default).
- Security: chat titles, project names and file paths are escaped on the dashboards, and the handover-brief prompt is safely quoted when it has to be typed into a shell.

## 1.3.0

- Live chats: every running chat on one page - working or waiting for you, your last ask and its latest reply ready to copy. Cards rise to the top as messages arrive.
- Use it or lose it: a quota bar that is about to reset with plenty left, or on course to run out first, is flagged under the bars, on the live board and in the status bar.
- Panel layouts: chats can sit side by side in the terminal panel, at the bottom or on the right.
- Open any chat straight into a split, running or not.
- Fix: placing a chat in a split no longer closes another pane - and the chat running in it.
- Opening a chat starts as soon as the pointer rests on it, so the click is instant.
- Refresh moved to the panel's title bar.

## 1.2.2

- Resume finds a chat's terminal when the editor was opened from the Dock, where it could not see the claude command and opened a second terminal instead.
- Long chats open straight away: the latest messages are drawn first and older ones as you scroll up.
- Opening a chat from a search result is faster.

## 1.2.1

- Chats on a 1M context model show the 1M window from the start, rather than 200K until they pass it.

## 1.2.0

- See what each running chat costs your laptop: memory and CPU for Claude and every command it started, with a warning when one gets heavy.
- Catch commands Claude left running after a chat ended, and stop them from the panel.
- The chat footer is grouped into Claude (context, cache, cost) and Laptop (memory, CPU), and lines up when the panel is narrow.

## 1.1.1

- Fixes a memory leak: a chat with screenshots left a full copy of itself in memory every time it was redrawn, so memory could climb into gigabytes over a long session. Measured on a chat with 277 screenshots, it now stays flat.

## 1.1.0

- Chat layouts: open chats in a fixed spot of the editor - halves, thirds, a stack or a grid - and move any open chat with a command, a shortcut or the chat list's right-click menu.
- Search is around a hundred times faster, built on an index instead of re-reading every transcript.
- Resume straight from a search result; Resume opens without a pause.
- A runner shows inside an open chat while Claude is working, and stops the moment it finishes.
- Renaming a chat renames a running session and its terminal tab; tabs follow the chat's title.
- Copied messages keep real bullet and numbered lists in Slack.
- Notices from background agents and other sessions show as notes, with the agent's report, rather than as your messages.
- Live chats redraw only what changed, so the view keeps up with the terminal.
- Fixes: a finished chat no longer shows as working; token and cost counts no longer double-count replies; sub-agent usage is included.

## 1.0.1

- Homepage and issue links point to the public project page.

## 1.0.0

First public release.

- Read, search and resume Claude Code and Codex sessions, grouped by project.
- Sub-agents shown where they were launched, as a tree, each openable as its own thread.
- Dashboard over your whole history: tokens, cost, cache efficiency, models, projects, files, hours.
- Per-chat stats, including context growth and prompt-cache expiry.
- Shareable PNG usage card.
- Plan-usage bars across the top of the panel, chosen in Settings.
- Groups, pins, archive, rename - a rename reaches a session that is running in a terminal.
