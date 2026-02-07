import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./components/TerminalPane";

type Agent = {
  id: string;
  name: string;
  role: string;
};

type SpawnResult = {
  id: string;
  name: string;
  role: string;
};

type AgentExitedEvent = {
  id: string;
  code?: number;
};

function makeWorkerName(existing: Agent[]): string {
  let i = 1;
  while (existing.some((a) => a.name === `worker-${i}`)) i++;
  return `worker-${i}`;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string>("");

  const hub = useMemo(() => agents.find((a) => a.name === "hub"), [agents]);
  const others = useMemo(() => agents.filter((a) => a.name !== "hub"), [agents]);

  useEffect(() => {
    let unlistenExit: (() => void) | null = null;

    listen<AgentExitedEvent>("agent-exited", (event) => {
      const exitedId = event.payload.id;
      setAgents((prev) => prev.filter((a) => a.id !== exitedId));
    }).then((f) => {
      unlistenExit = f;
    });

    return () => {
      if (unlistenExit) unlistenExit();
    };
  }, []);

  async function spawn(name: string, role: string): Promise<void> {
    setError("");
    try {
      const result = await invoke<SpawnResult>("spawn_agent", { name, role });
      setAgents((prev) => {
        const without = prev.filter((a) => a.id !== result.id && a.name !== result.name);
        return [...without, result];
      });
    } catch (err: any) {
      setError(err?.toString?.() || "Spawn failed");
    }
  }

  async function kill(id: string): Promise<void> {
    setError("");
    try {
      await invoke("kill_agent", { id });
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (err: any) {
      setError(err?.toString?.() || "Kill failed");
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <strong>🐝 Hive Desktop (Phase 1)</strong>
        <div className="toolbar-actions">
          <button onClick={() => spawn("hub", "hub")} disabled={Boolean(hub)}>
            Start Hub
          </button>
          <button onClick={() => spawn(makeWorkerName(agents), "worker")}>Spawn Worker</button>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <main className="layout">
        <section className="hub-pane">
          {hub ? (
            <TerminalPane
              key={hub.id}
              agentId={hub.id}
              title={`🐝 ${hub.name} (${hub.role})`}
              onKill={() => kill(hub.id)}
            />
          ) : (
            <div className="empty">Hub not running. Click "Start Hub".</div>
          )}
        </section>

        <section className="agents-pane">
          {others.length === 0 ? (
            <div className="empty">No agents yet. Spawn one.</div>
          ) : (
            others.map((agent) => (
              <TerminalPane
                key={agent.id}
                agentId={agent.id}
                title={`🐝 ${agent.name} (${agent.role})`}
                onKill={() => kill(agent.id)}
              />
            ))
          )}
        </section>
      </main>
    </div>
  );
}
