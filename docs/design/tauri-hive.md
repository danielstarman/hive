# Hive Desktop — Design Sketch

> A CLI that has a GUI. Terminal-native multi-agent workspace.

```
$ cd my-project
$ hive
```

Window opens. Agents spawn. You're in control.

---

## Mental Model

```
┌─ Hive Window ──────────────────────────────────────────────┐
│                                                            │
│  ┌─ Hub ──────────────┐  ┌─ worker ──────┐ ┌─ scout ────┐ │
│  │ $ pi               │  │ $ pi          │ │ $ pi       │ │
│  │ > reading files... │  │ > editing ... │ │ > grep ... │ │
│  │                    │  │               │ │            │ │
│  │                    │  │               │ │            │ │
│  │                    │  ├───────────────┤ ├────────────┤ │
│  │                    │  │ reviewer      │ │ (empty)    │ │
│  │                    │  │ $ pi          │ │            │ │
│  │                    │  │ > waiting ... │ │            │ │
│  └────────────────────┘  └───────────────┘ └────────────┘ │
│                                                            │
│  ┌─ Dashboard ─────────────────────────────────────────┐   │
│  │ 🟢 hub  🔥 worker  🟢 scout  🟡 reviewer           │   │
│  │ #backend: worker, scout │ Reserved: src/index.ts 🔒 │   │
│  │ [Broadcast...] [Spawn Agent] [Kill] [Pause]         │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Tauri App                        │
│                                                  │
│  ┌─ Rust Backend ─────────────────────────────┐  │
│  │                                            │  │
│  │  BrokerHost        PtyManager              │  │
│  │  ┌──────────┐      ┌─────────────────┐     │  │
│  │  │ Hive     │      │ portable-pty    │     │  │
│  │  │ Broker   │      │                 │     │  │
│  │  │ (WS)     │      │ pty0 (hub)      │     │  │
│  │  │          │      │ pty1 (worker)   │     │  │
│  │  │          │      │ pty2 (scout)    │     │  │
│  │  └────┬─────┘      └───────┬─────────┘     │  │
│  │       │                    │               │  │
│  │       │ IPC events         │ IPC bytes     │  │
│  │       │                    │               │  │
│  └───────┼────────────────────┼───────────────┘  │
│          │                    │                   │
│  ┌───────┼────────────────────┼───────────────┐  │
│  │  React Frontend            │               │  │
│  │       │                    │               │  │
│  │  ┌────▼─────┐    ┌────────▼──────────┐     │  │
│  │  │Dashboard │    │  xterm.js panes   │     │  │
│  │  │  React   │    │  (one per agent)  │     │  │
│  │  └──────────┘    └───────────────────┘     │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Data Flow

1. **Agent spawning**: CLI/UI → Rust `PtyManager` → `portable-pty` creates ConPTY → spawns `pi -e <hive-ext>` with env vars
2. **Terminal I/O**: ConPTY ↔ Rust reads/writes ↔ Tauri IPC ↔ xterm.js renders
3. **Broker events**: Pi extension connects to broker via WebSocket → broker emits events → Rust forwards via Tauri IPC → React dashboard updates
4. **Operator actions**: React button click → Tauri IPC → Rust command → broker DM/broadcast → agent receives

---

## Project Structure

```
hive-app/
├── src-tauri/                  # Rust backend
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             # Tauri entry, CLI parsing
│       ├── broker.rs           # Embed or connect to hive broker
│       ├── pty_manager.rs      # ConPTY lifecycle (spawn, kill, resize)
│       ├── ipc.rs              # Tauri commands (frontend ↔ backend)
│       └── cli.rs              # CLI arg parsing (clap)
│
├── src/                        # React frontend
│   ├── App.tsx                 # Main layout
│   ├── components/
│   │   ├── TerminalPane.tsx    # xterm.js wrapper
│   │   ├── PaneGrid.tsx        # Resizable grid layout
│   │   ├── Dashboard.tsx       # Agent status, controls
│   │   ├── AgentCard.tsx       # Single agent status card
│   │   ├── ChannelList.tsx     # Channel sidebar
│   │   ├── ReservationMap.tsx  # File lock visualization
│   │   ├── TopologyGraph.tsx   # Agent connection graph
│   │   └── CommandBar.tsx      # Operator input (broadcast, spawn)
│   ├── hooks/
│   │   ├── usePty.ts           # xterm.js ↔ Tauri IPC bridge
│   │   ├── useBroker.ts        # Broker events via IPC
│   │   └── useLayout.ts        # Pane arrangement state
│   └── stores/
│       └── hiveStore.ts        # Zustand — agents, channels, reservations
│
├── package.json                # React deps + xterm.js
├── tauri.conf.json             # Tauri config
└── hive-ext/                   # Existing pi extension (symlinked or copied)
    └── src/
```

---

## Rust Backend

### PtyManager

```rust
use portable_pty::{CommandBuilder, PtySize, native_pty_system};

struct PtyAgent {
    id: String,
    name: String,
    pty: Box<dyn MasterPty>,
    child: Box<dyn Child>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
}

struct PtyManager {
    agents: HashMap<String, PtyAgent>,
    broker_port: u16,
}

impl PtyManager {
    fn spawn_agent(&mut self, name: &str, role: &str, task: Option<&str>,
                   size: PtySize) -> Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size)?;

        let mut cmd = CommandBuilder::new("pi");
        cmd.arg("-e").arg("./hive-ext/src/index.ts");
        if let Some(t) = task {
            cmd.arg(t);
        }

        // Hive env vars — same as current pane spawning
        cmd.env("HIVE_BROKER", format!("ws://127.0.0.1:{}", self.broker_port));
        cmd.env("HIVE_NAME", name);
        cmd.env("HIVE_ID", &id);
        cmd.env("HIVE_PARENT", "hub");
        cmd.env("HIVE_ROLE", role);
        cmd.env("HIVE_INTERACTIVE", "0");

        let child = pair.slave.spawn_command(cmd)?;
        // Store agent, start reader thread → IPC events
        Ok(id)
    }

    fn resize_agent(&mut self, id: &str, size: PtySize) -> Result<()> {
        self.agents.get(id)?.pty.resize(size)  // ← THE RESIZE WE'VE BEEN WANTING
    }

    fn kill_agent(&mut self, id: &str) -> Result<()> {
        self.agents.get_mut(id)?.child.kill()
    }

    fn write_to_agent(&mut self, id: &str, data: &[u8]) -> Result<()> {
        self.agents.get_mut(id)?.writer.write_all(data)
    }
}
```

### Tauri IPC Commands

```rust
#[tauri::command]
fn spawn_agent(name: String, role: String, task: Option<String>,
               state: State<AppState>) -> Result<String, String> { ... }

#[tauri::command]
fn kill_agent(id: String, state: State<AppState>) -> Result<(), String> { ... }

#[tauri::command]
fn resize_agent(id: String, cols: u16, rows: u16,
                state: State<AppState>) -> Result<(), String> { ... }

#[tauri::command]
fn write_pty(id: String, data: Vec<u8>,
             state: State<AppState>) -> Result<(), String> { ... }

#[tauri::command]
fn broadcast_message(content: String,
                     state: State<AppState>) -> Result<(), String> { ... }

#[tauri::command]
fn dm_agent(name: String, content: String,
            state: State<AppState>) -> Result<(), String> { ... }
```

### Tauri Events (backend → frontend)

```rust
// PTY output — stream terminal bytes to xterm.js
app.emit("pty-output", PtyOutput { agent_id, data: bytes });

// Broker events — forwarded to dashboard
app.emit("agent-joined", AgentInfo { ... });
app.emit("agent-left", AgentLeft { name, id });
app.emit("status-changed", StatusChanged { name, status, message });
app.emit("reservations-updated", Reservations { ... });
app.emit("broadcast", Broadcast { from, content });
```

---

## React Frontend

### TerminalPane.tsx

```tsx
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useRef } from "react";
import { listen, invoke } from "@tauri-apps/api";

function TerminalPane({ agentId, agentName }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal>();

  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current!);
    fit.fit();
    xtermRef.current = term;

    // PTY output → xterm
    const unlisten = listen<{ agent_id: string; data: number[] }>(
      "pty-output",
      (event) => {
        if (event.payload.agent_id === agentId) {
          term.write(new Uint8Array(event.payload.data));
        }
      }
    );

    // xterm input → PTY
    term.onData((data) => {
      invoke("write_pty", { id: agentId, data: [...Buffer.from(data)] });
    });

    // Resize → PTY
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      invoke("resize_agent", {
        id: agentId,
        cols: term.cols,
        rows: term.rows,
      });
    });
    resizeObserver.observe(termRef.current!);

    return () => { unlisten.then(f => f()); term.dispose(); };
  }, [agentId]);

  return (
    <div className="terminal-pane">
      <div className="pane-header">
        <span className="pane-name">🐝 {agentName}</span>
      </div>
      <div ref={termRef} className="pane-terminal" />
    </div>
  );
}
```

### PaneGrid.tsx

```tsx
import { Allotment } from "allotment"; // resizable split panes
import "allotment/dist/style.css";

function PaneGrid({ agents }: { agents: Agent[] }) {
  const hub = agents.find(a => a.isHub);
  const others = agents.filter(a => !a.isHub);

  return (
    <Allotment>
      {/* Hub always left 50% */}
      <Allotment.Pane preferredSize="50%">
        {hub && <TerminalPane agentId={hub.id} agentName={hub.name} />}
      </Allotment.Pane>

      {/* Right side — stack agents vertically */}
      <Allotment.Pane>
        <Allotment vertical>
          {others.map(agent => (
            <Allotment.Pane key={agent.id}>
              <TerminalPane agentId={agent.id} agentName={agent.name} />
            </Allotment.Pane>
          ))}
        </Allotment>
      </Allotment.Pane>
    </Allotment>
  );
}
```

### Dashboard.tsx

```tsx
function Dashboard() {
  const agents = useHiveStore(s => s.agents);
  const reservations = useHiveStore(s => s.reservations);
  const channels = useHiveStore(s => s.channels);

  return (
    <div className="dashboard">
      <div className="agent-bar">
        {agents.map(a => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>

      <div className="controls">
        <SpawnButton />
        <BroadcastInput />
        <PauseAllButton />
      </div>

      <div className="panels">
        <ChannelList channels={channels} />
        <ReservationMap reservations={reservations} />
      </div>
    </div>
  );
}
```

---

## CLI Interface

```
hive — Multi-agent workspace for pi

USAGE:
    hive [COMMAND] [OPTIONS]

COMMANDS:
    (default)           Launch GUI workspace
    spawn <name>        Spawn agent in running instance
    kill <name>         Kill agent in running instance
    agents              List agents (prints to stdout)
    broadcast <msg>     Send broadcast
    status              Show workspace status

OPTIONS:
    --headless          No GUI — broker + terminal panes only (WT/ConPTY)
    --project <path>    Set working directory (default: cwd)
    --port <port>       Broker port (default: auto)
    --layout <file>     Load saved layout (.hive.json)

EXAMPLES:
    hive                            # Launch workspace
    hive --project ./my-app         # Launch in specific directory
    hive spawn worker "fix tests"   # Add agent to running workspace
    hive agents                     # List agents
    hive --headless                 # CI mode, no GUI
```

### CLI → Running Instance Communication

When `hive` is already running, subcommands talk to it:

```
hive spawn worker "fix tests"
  └→ connects to broker (port from broker.json in temp dir)
  └→ sends spawn command
  └→ prints "Spawned worker" to stdout
  └→ exits
```

Same broker.json discovery mechanism we already have.

---

## What Changes, What Doesn't

### Unchanged
- `src/broker/` — protocol, server (broker is broker)
- `src/client/` — connection, inbox
- `src/tools/` — all LLM tools
- `src/index.ts` — pi extension entry point
- `test/` — all broker tests
- Pi agents have NO IDEA they're in xterm.js vs Windows Terminal

### Changed
- `src/layout/panes.ts` — replaced by Rust PtyManager (or kept as headless fallback)
- Broker hosting — moves from Node.js in-process to Rust in-process (or: Rust just spawns the Node broker as a child process to start)

### New
- `src-tauri/` — entire Rust backend
- `src/` (React) — entire frontend
- CLI binary

---

## Migration Path (Incremental)

### Phase 1: Proof of Concept
- Tauri app that opens a single xterm.js pane
- Spawns one `pi` instance via ConPTY
- Terminal I/O works (type, see output, pi TUI renders)
- **Validates**: xterm.js + ConPTY + pi's ink-based TUI

### Phase 2: Multi-Pane
- PtyManager spawns multiple agents
- Resizable grid layout (Allotment)
- Resize propagation (grid resize → PTY resize → pi reflows)
- **Validates**: multi-agent terminal management

### Phase 3: Broker Integration
- Embed hive broker (spawn as Node child or port to Rust)
- Dashboard shows live agent status
- Operator can broadcast/DM from UI
- **Validates**: broker ↔ UI data flow

### Phase 4: Full Dashboard
- Channels, reservations, topology
- Spawn/kill from UI
- Approval workflows
- Layout saving/loading

### Phase 5: CLI Polish
- `hive spawn`, `hive agents`, etc.
- `--headless` mode (fallback to WT panes)
- Package and distribute

---

## Key Dependencies

### Rust (src-tauri/Cargo.toml)
```toml
[dependencies]
tauri = { version = "2", features = ["shell-open"] }
portable-pty = "0.8"                # ConPTY/PTY abstraction
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }  # CLI parsing
```

### Frontend (package.json)
```json
{
  "@xterm/xterm": "^5.5",
  "@xterm/addon-fit": "^0.10",
  "@xterm/addon-webgl": "^0.18",
  "allotment": "^1.0",            // resizable split panes
  "zustand": "^5",                 // state management
  "@tauri-apps/api": "^2",
  "react": "^19",
  "react-dom": "^19"
}
```

---

## Open Questions

1. **Broker in Rust or Node?** Easiest: Rust spawns `node broker.js` as child process. Cleanest: rewrite broker in Rust (it's ~300 lines, mostly WebSocket routing). Compromise: keep Node broker, Rust connects as a "dashboard" client.

2. **Hub agent**: Is the hub still a pi instance in a pane, or does the Tauri app itself become the hub? Probably: hub is still a pi pane, Tauri app is an observer/operator that connects to the broker as a special client.

3. **Pi TUI compatibility**: Pi uses ink (React for CLI). It renders ANSI escape sequences. xterm.js handles ANSI natively. Should Just Work™ — but needs Phase 1 validation.

4. **Repo structure**: Separate repo (`hive-app`)? Or monorepo with `hive-ext/` (current) + `hive-app/` (new)? Monorepo probably makes sense.

5. **Distribution**: Single binary via GitHub releases? npm package? Both?
