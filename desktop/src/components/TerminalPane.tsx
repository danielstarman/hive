import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

type Props = {
  agentId: string;
  title: string;
  onKill: () => void;
};

type PtyOutputEvent = {
  id: string;
  data: number[];
};

export function TerminalPane({ agentId, title, onKill }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 13,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("resize_pty", { id: agentId, cols: term.cols, rows: term.rows }).catch(() => undefined);
    });
    ro.observe(containerRef.current);

    term.onData((data) => {
      invoke("write_pty", { id: agentId, data }).catch(() => undefined);
    });

    let unlistenOutput: (() => void) | null = null;
    listen<PtyOutputEvent>("pty-output", (event) => {
      if (event.payload.id !== agentId) return;
      term.write(new Uint8Array(event.payload.data));
    }).then((f) => {
      unlistenOutput = f;
    });

    // Initial resize sync
    invoke("resize_pty", { id: agentId, cols: term.cols, rows: term.rows }).catch(() => undefined);

    return () => {
      ro.disconnect();
      if (unlistenOutput) unlistenOutput();
      term.dispose();
    };
  }, [agentId]);

  return (
    <article className="terminal-shell">
      <div className="terminal-header">
        <span>{title}</span>
        <button className="danger" onClick={onKill}>
          Kill
        </button>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </article>
  );
}
