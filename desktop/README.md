# Hive Desktop (Phase 1 POC)

This is the first implementation slice of the Tauri + xterm.js desktop shell for hive.

## What works

- Tauri desktop app window
- Spawn one or more `pi` processes, each in its own ConPTY via `portable-pty`
- Render each agent terminal in xterm.js
- Send keyboard input from xterm.js → PTY
- Stream output from PTY → xterm.js
- Resize panes in UI and propagate rows/cols to PTY
- Kill agents from the UI

## Run

From repo root:

```bash
cd desktop
npm install
npm run tauri:dev
```

Then click:

- **Start Hub**
- **Spawn Worker**

Each pane runs `pi -e <repo>/src/index.ts`.

## Notes

- This is **Phase 1** from `docs/design/tauri-hive.md`.
- Broker/dashboard integration is next. Right now this is terminal orchestration + PTY plumbing.
- The current implementation expects the hive extension to exist at `../src/index.ts` relative to this folder.
