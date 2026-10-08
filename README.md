# Mission Tracker

A Claude Code mod that keeps a live tree of your mission (stages, tasks, subtasks) in a side pane, and has Claude update it as the work changes.

## What it does

- **Side pane** with the mission title, a progress bar and the full tree. Click `[ ]` to cycle an item: todo → doing → done.
- **Claude keeps it current.** Claude gets a `mission` tool plus standing instructions to add new stages and subtasks the moment they come up, and to set statuses as work moves.
- **Nothing disappears quietly.** Items Claude added since your last message are tagged `NEW`. Dropped work shows as cancelled (struck through) instead of vanishing.
- **Status line:** `🎯 Mission · 5/12 · now: <current task>`
- **Survives restarts and compaction.** The tree is saved per project folder, and Claude sees the current tree on every turn.
- **Toasts** when new items get added and when the mission is complete.

Status marks: `[ ]` todo · `[~]` doing · `[x]` done · `[!]` blocked · `[-]` cancelled

## Commands

| Command | What it does |
| --- | --- |
| `/mission` | Open the pane |
| `/mission new <title>` | Start a new mission (the old one is archived) |
| `/mission add <task>` | Add a top-level task yourself |
| `/mission show` | Print the tree into the chat |
| `/mission archive` | Archive the current mission and close the pane |

Or just tell Claude: "track this as a mission".

## Install

From a terminal session of Claude Code:

```
/plugin install mission-tracker --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick the user scope. Once installed at the user scope it also loads in the desktop app's Code tab.

To try it from a local folder without installing:

```
claude --plugin-dir /path/to/mission-tracker
```

## Development

```
claude plugin validate .
claude plugin test .
```
