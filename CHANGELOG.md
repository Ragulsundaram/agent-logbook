# Changelog

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
