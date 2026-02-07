# Idea: Add `resize-pane` to Windows Terminal CLI

## The Problem

Windows Terminal's `wt` CLI can split panes, move focus, and swap panes — but **cannot resize panes after creation**. The only way to resize is manually (Alt+Shift+Arrow or mouse drag). This means any tool that programmatically manages pane layouts (like hive) is stuck with whatever sizes were set at split time.

## The Opportunity

This would be a **big win for the ecosystem**, not just hive. Any tool that orchestrates WT panes (tmux-like wrappers, IDE integrations, agent frameworks, dev environment managers) would benefit. Currently there's no programmatic way to adjust layout after creation.

Proposed command:
```bash
wt -w 0 resize-pane --direction right --amount 10
# or with percentages:
wt -w 0 resize-pane --direction right --percent 5
```

## Prior Art & Community Interest

**Nobody has filed a dedicated issue for exposing `resize-pane` as a CLI command.** But the demand is clearly there — people keep hitting the wall:

### Related Issues
- **[#6002](https://github.com/microsoft/terminal/issues/6002)** — "Split panes equally in size" (open, 2020, 20+ comments). Tons of people want equal-split layouts from CLI. Workaround: manually calculate `--size` fractions at split time (exactly what hive does). People wrote Python/PowerShell scripts to compute the fractions. A WT team member (`zadjii-msft`) suggested a `resizeParents: true` arg on `splitPane`. **4+ years open, no resolution.**
- **[#4456](https://github.com/microsoft/terminal/issues/4456)** — "Ability to evenly resize splits" (open). Wants a keystroke to equalize panes.
- **[#17843](https://github.com/microsoft/terminal/issues/17843)** — "Allow user to specify resize amount" (open, Sep 2024). WT team member `carlos-zamora` wrote a **detailed implementation guide** in the comments (which files to edit, what methods to call). A volunteer started but never finished.
- **[#16895](https://github.com/microsoft/terminal/pull/16895)** — Related PR pointed to by the WT team.

### The Gap
Everyone's asking for resize at *split time* (equal splits) or via *keyboard* (custom amounts). But **nobody has asked for resize via `wt` CLI after creation**. This is the real unlock — it enables:
- Dynamic rebalancing by external tools
- Layout management scripts
- Agent frameworks (like hive) adjusting panes at runtime
- tmux-like pane management wrappers

### Community Workarounds
People are writing scripts to pre-calculate split fractions:
```python
# From issue #6002 — computing equal splits
sizes = np.arange(n-1, 0, -1) / np.arange(n, 1, -1)
# wt ;sp -H -s 0.8;sp -H -s 0.75;sp -H -s 0.67;sp -H -s 0.5
```
This only works at creation time. Once panes exist, you're stuck.

## Implementation Scope (Small)

From carlos-zamora's guide, the changes touch ~5 files:

### TerminalSettingsModel (serialization)
- `ActionArgs.idl` — add args to `ResizePaneArgs` (or create new CLI action)
- `ActionArgs.h` — update `RESIZE_PANE_ARGS` macro
- `ActionArgs.cpp` — `GenerateName` for command palette display
- `Resources.resw` — localized strings (use VS editor, not VS Code!)

### TerminalApp (app logic)
- `AppActionHandlers.cpp` — `_HandleResizePane()` already exists, just wire new args
- `Pane.h/cpp` — `Pane::_Resize()` already handles the resize. The `amount` variable controls how much (currently 5% of pane size)

### CLI layer
- Add `resize-pane` subcommand to the `wt` CLI parser, following the pattern of `move-focus` or `swap-pane`

**Estimated effort**: 200-300 lines across 5-6 files. Weekend project for someone familiar with the codebase. The hard part (resize logic) is already done.

### Key design question
What units for `--amount`? Options:
- **Percentage** (easiest — just modify `_desiredSplitPosition` directly)
- **Pixels** (easy, but feels wrong for a terminal)
- **Rows/columns** (most useful, but requires querying font dimensions from the pane's `TermControl::CharacterDimensions`)

The WT team member suggested percentage as the simplest path.

## Why This Matters for Hive

With `resize-pane` in the CLI, hive could:
1. Dynamically rebalance panes when agents are added/removed
2. Give the hub more space when it needs it
3. Shrink idle agent panes, expand active ones
4. Fix layout after manual resizing by users
5. Implement proper grid layouts without needing WezTerm

## Next Steps

Options:
1. **Contribute it ourselves** — fork microsoft/terminal, follow carlos-zamora's guide, submit PR. Build env setup is the hardest part (big C++ project with Windows SDK deps).
2. **Comment on #17843** — express interest, ask if the volunteer finished, offer to pick it up.
3. **File a new issue** specifically for CLI exposure (the existing issue is about keyboard resize amounts, not CLI).

Recommendation: File a new focused issue ("Expose resize-pane as a wt CLI subcommand") referencing #17843's implementation guide, then consider submitting the PR.
