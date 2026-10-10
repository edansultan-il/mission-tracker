# Mission Tracker

A Claude Code mod that keeps live mission trees (stages, tasks, subtasks) in a side pane, and has Claude keep them up to date while the work changes.

## What it does

- **Missions are shared by every chat on your computer.** Each chat works on one, many run side by side, and starting a mission never touches another chat's. Any chat can list them and join one by id or title, whatever folder or worktree it runs in.
- **Sub-missions.** A mission can deliver one item of a bigger mission (E1 under "Package E"). The parent shows the sub-mission's progress on that item and ticks it when the sub-mission finishes. Each chat sees the other's changes within seconds.
- **Claude keeps it current.** It adds stages and subtasks the moment they come up, sets statuses as it works, and can update an item in another mission ("E4 is done").
- **Your own numbering.** Give items codes like `E1` or `4.1`; they show before the title and work anywhere an id does. Reorder with a move instead of rebuilding, so ids stay put.
- **A clean pane.** Progress bar, the task in progress, colored status marks with a legend, due dates (red when overdue), owners, finished stages folded to one line, and right-to-left layout for Hebrew missions.
- **All missions view.** Every active mission on your computer (this project's first), sub-missions nested under their parents, with buttons to open one here or restore an archived one.
- **Stays open** while a mission is unfinished, until you close the pane yourself.

Status marks: `○` to do · `◐` in progress · `✓` done · `!` blocked · `✕` dropped

## Commands

| Command | What it does |
| --- | --- |
| `/mission` | Open the pane |
| `/mission new <title>` | Start a mission for this chat |
| `/mission join <name>` | Attach this chat to an existing mission |
| `/mission list` | List active and archived missions |
| `/mission report` | Print a handoff summary: done, in progress, blocked, next up |
| `/mission add <task>` | Add a task yourself |
| `/mission show` | Print this chat's tree |
| `/mission archive [name]` | Put a mission away |
| `/mission restore <name>` | Bring an archived mission back to this chat |

Or just tell Claude: "track this as a mission", or "this is E1 of Package E".

## Install

```
/plugin install mission-tracker --marketplace edansultan-il/mission-tracker
```

Or from PowerShell or any shell:

```
claude plugin marketplace add edansultan-il/mission-tracker
claude plugin install mission-tracker@mission-tracker
```

To update later:

```
claude plugin marketplace update mission-tracker
claude plugin update mission-tracker@mission-tracker
```

Then run `/reload-plugins` in open chats.

## Where missions live

One JSON file per mission in `~/.claude/mission-tracker/missions/`, and one small file per chat in `~/.claude/mission-tracker/chats/`. Every chat reads them straight from disk, so a change in one chat shows in the others within a few seconds. Missions kept by earlier versions move there on first start.

## Development

```
claude plugin validate .
claude plugin test .
```
