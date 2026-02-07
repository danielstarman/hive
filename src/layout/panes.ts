/**
 * Windows Terminal pane management.
 *
 * Spawns new pi instances in split panes using the `wt` CLI.
 * Smart layout:
 * - pane 0: split right (-V) at 50%
 * - pane 1+: move focus right, split below (-H) with adaptive size
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_PANES = 8;

export interface SpawnPaneOptions {
  /** Working directory for the new pane */
  cwd: string;
  /** Full command-line arguments for the pi process */
  piArgs: string[];
  /** Current number of spawned panes (0 = first spawn) */
  paneCount: number;
  /** Environment variables to pass to the child process */
  env?: Record<string, string>;
}

export interface SpawnPaneResult {
  ok: boolean;
  command: string;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  error?: string;
}

/**
 * Escape a command argument for safe use in `cmd /c ...`.
 */
export function escapeCmdArg(arg: string): string {
  if (!arg) return '""';
  const escaped = arg
    .replace(/\^/g, "^^")
    .replace(/&/g, "^&")
    .replace(/\|/g, "^|")
    .replace(/</g, "^<")
    .replace(/>/g, "^>")
    .replace(/%/g, "%%")
    .replace(/!/g, "^^!")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatWtCommand(binary: string, args: string[]): string {
  const rendered = args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
  return `${binary} ${rendered}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAdaptiveSplitSize(paneCount: number, maxPanes = DEFAULT_MAX_PANES): string {
  // Requested formula: (maxPanes - N) / (maxPanes - N + 1)
  const n = clamp(paneCount, 1, maxPanes - 1);
  const size = (maxPanes - n) / (maxPanes - n + 1);
  return size.toFixed(4);
}

function buildInnerCommand(piArgs: string[], env?: Record<string, string>): string {
  const piCmd = process.platform === "win32" ? "pi.cmd" : "pi";
  const piArgsStr = piArgs.map((a) => escapeCmdArg(a)).join(" ");

  if (env && Object.keys(env).length > 0) {
    const setCommands = Object.entries(env)
      .map(([k, v]) => `set "${k}=${String(v).replace(/"/g, '\\"')}"`)
      .join(" & ");
    return `${setCommands} & ${piCmd} ${piArgsStr}`;
  }

  return `${piCmd} ${piArgsStr}`;
}

function buildWtArgs(opts: SpawnPaneOptions, innerCmd: string): string[] {
  if (opts.paneCount === 0) {
    return [
      "-w",
      "0",
      "split-pane",
      "-V",
      "--size",
      "0.5",
      "-d",
      opts.cwd,
      "--",
      "cmd",
      "/c",
      innerCmd,
    ];
  }

  // pane 1+ => keep spawning in the right-side column
  const size = getAdaptiveSplitSize(opts.paneCount);
  return [
    "-w",
    "0",
    "move-focus",
    "right",
    ";",
    "split-pane",
    "-H",
    "--size",
    size,
    "-d",
    opts.cwd,
    "--",
    "cmd",
    "/c",
    innerCmd,
  ];
}

/**
 * Spawn a new pi instance in a Windows Terminal pane.
 */
export async function spawnPane(
  pi: ExtensionAPI,
  opts: SpawnPaneOptions
): Promise<SpawnPaneResult> {
  const innerCmd = buildInnerCommand(opts.piArgs, opts.env);
  const args = buildWtArgs(opts, innerCmd);

  let lastFailure: SpawnPaneResult | null = null;

  for (const binary of ["wt", "wt.exe"]) {
    const command = formatWtCommand(binary, args);

    try {
      const result = await pi.exec(binary, args, { timeout: 10000 });
      if (result.code === 0) {
        return {
          ok: true,
          command,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }

      lastFailure = {
        ok: false,
        command,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        error: `Windows Terminal exited with code ${result.code}`,
      };
    } catch (err: any) {
      lastFailure = {
        ok: false,
        command,
        error: err?.message || "Failed to execute Windows Terminal",
      };
    }
  }

  return (
    lastFailure || {
      ok: false,
      command: "wt",
      error: "Windows Terminal not available",
    }
  );
}
