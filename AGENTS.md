# Hive — Multi-Agent Chat Network for Pi

This is the **hive** project — a pi extension that turns Windows Terminal into a multi-agent workspace.

## Quick Reference

- **Repo**: https://github.com/danielstarman/hive
- **Extension entry**: `src/index.ts`
- **Run**: `pi -e ./src/index.ts` or just `pi` (if junction/symlink is set up)
- **Tests**: `npx tsx test/broker-test.ts`

## Architecture

```
Hub (your pi)  ──WebSocket──  Broker (in-process)  ──WebSocket──  Agent panes (spawned pi instances)
```

- Hub starts a WebSocket broker, writes `.pi/hive/broker.json`
- Spawned agents discover the broker via that file and connect
- Communication: DMs (sync/async), broadcast, channels
- Identity passed via env vars (HIVE_BROKER, HIVE_NAME, HIVE_ID, HIVE_PARENT, HIVE_ROLE)

## Tools Available

| Tool | Description |
|------|-------------|
| `hive_spawn` | Spawn agent in a new WT pane |
| `hive_chat` | DM an agent, wait for response |
| `hive_send` | Fire-and-forget DM |
| `hive_broadcast` | Message all agents |
| `hive_agents` | List online agents |
| `hive_status` | Set your status (idle/busy/done) |

## Commands

- `/hive` — Network overview
- `/hive:agents` — List agents
- `/hive:broadcast <msg>` — Broadcast

## Key Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Extension entry — hub/child detection, event wiring |
| `src/broker/server.ts` | WebSocket broker — routing, registry, channels |
| `src/broker/protocol.ts` | All message type definitions |
| `src/client/connection.ts` | WebSocket client with agent cache |
| `src/client/inbox.ts` | Message queue — injects DMs into pi conversation |
| `src/layout/panes.ts` | Windows Terminal pane spawning |
| `src/tools/*.ts` | One file per hive tool |
| `agents/*.md` | Agent persona definitions |
| `test/broker-test.ts` | Integration tests (43 passing) |

## Open Issues

- P5: Channel tools (broker supports it, needs LLM tools)
- P6: More slash commands (/hive:spawn, /hive:kill, /hive:feed)
- P7: Activity feed widget
- P8: Smart layout + pane rearrangement
- P10: Lifecycle management (graceful shutdown, orphans)
