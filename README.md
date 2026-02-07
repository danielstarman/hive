# Hive

A [pi](https://github.com/badlogic/pi-mono) extension that turns Windows Terminal into a multi-agent chat workspace.

Spawn agent panes that pop open beside you. Every agent connects to a shared broker and can DM each other, broadcast, form channels, and spawn sub-agents. You're just another node on the network — but with god powers.

## Architecture

```
                    ┌──────────────┐
                    │   Broker     │
                    │  (WebSocket) │
                    │  in-process  │
                    └──────┬───────┘
              ┌────────────┼────────────┐
              │            │            │
         ┌────┴────┐  ┌───┴────┐  ┌───┴─────┐
         │   Hub   │  │ Scout  │  │ Worker  │
         │  (you)  │  │ (pane) │  │ (pane)  │
         └─────────┘  └───┬────┘  └─────────┘
                          │
                     ┌────┴─────┐
                     │ Scout Jr │
                     │ (spawned │
                     │ by scout)│
                     └──────────┘
```

The hub starts the broker in-process. Spawned agents connect as clients. Every agent loads the same extension — it detects whether to be a hub or a child based on CLI flags.

## Status

🚧 Under active development. See [issues](../../issues) for the roadmap.

## Desktop POC (Tauri)

A new experimental desktop shell lives in `desktop/`:

- Tauri (Rust backend)
- ConPTY via `portable-pty`
- xterm.js panes (one per agent)

Run it with:

```bash
cd desktop
npm install
npm run tauri:dev
```

Details: `desktop/README.md` and `docs/design/tauri-hive.md`.

## Installation

```bash
cd hive
npm install
# Then from any project:
pi -e /path/to/hive/src/index.ts
```

Or symlink into your pi extensions:

```bash
# Windows (mklink)
mklink /D "%USERPROFILE%\.pi\agent\extensions\hive" "C:\Users\dstar\Code\hive"
```

## Usage

Once loaded, the LLM has access to hive tools:

- **hive_spawn** — Spawn a new agent in a Windows Terminal pane
- **hive_chat** — DM an agent and wait for a response
- **hive_send** — Fire-and-forget message to an agent
- **hive_broadcast** — Message all agents
- **hive_agents** — List who's online
- **hive_channels** — List channels
- **hive_channel_create/join/leave/send** — Channel operations

Slash commands for you:

- `/hive` — Network overview
- `/hive:spawn <agent> [task]` — Spawn interactively
- `/hive:agents` — List agents
- `/hive:channels` — List channels and members
- `/hive:kill <name>` — Disconnect an agent
- `/hive:feed` — Toggle activity feed

## Agent Definitions

Markdown files with YAML frontmatter in `~/.pi/agent/agents/` or `.pi/agents/`:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

You are a scout agent. Your job is to quickly survey codebases...
```

## License

MIT
