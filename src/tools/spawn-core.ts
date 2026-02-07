/**
 * Shared spawn implementation used by the hive_spawn tool and /hive:spawn command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnPane } from "../layout/panes.js";
import type { HiveState } from "../index.js";

export interface SpawnAgentParams {
  name: string;
  role?: string;
  task?: string;
  cwd?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string;
  interactive?: boolean;
}

export interface SpawnAgentResult {
  ok: boolean;
  message: string;
  details?: Record<string, any>;
}

export async function spawnAgent(
  pi: ExtensionAPI,
  state: HiveState,
  ctx: any,
  params: SpawnAgentParams
): Promise<SpawnAgentResult> {
  if (!state.client || !state.client.isConnected()) {
    return {
      ok: false,
      message: "Error: Not connected to hive broker",
    };
  }

  const agentId = crypto.randomUUID();
  const agentName = (params.name || "").trim();
  if (!agentName) {
    return {
      ok: false,
      message: "Agent name is required.",
    };
  }

  const agentRole = params.role || "general-purpose agent";
  const agentCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
  const interactive = params.interactive !== false;

  // Write system prompt to temp file if provided
  let tmpDir: string | null = null;
  let promptFile: string | null = null;

  if (params.systemPrompt) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-agent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    promptFile = path.join(tmpDir, `prompt-${safeName}.md`);
    fs.writeFileSync(promptFile, params.systemPrompt, { encoding: "utf-8" });
    state.tempFiles.push({ dir: tmpDir, file: promptFile });
  }

  // Build pi command arguments
  const piArgs: string[] = [];
  piArgs.push("-e", state.extensionPath);

  if (params.model) piArgs.push("--model", params.model);
  if (params.tools) piArgs.push("--tools", params.tools);
  if (promptFile) piArgs.push("--append-system-prompt", promptFile);
  if (params.task) piArgs.push(params.task);

  // Pass hive identity via env vars (more reliable through wt split-pane than CLI flags)
  // The child extension also discovers broker.json from cwd as a fallback
  const env: Record<string, string> = {
    HIVE_BROKER: `ws://127.0.0.1:${state.brokerPort}`,
    HIVE_NAME: agentName,
    HIVE_ID: agentId,
    HIVE_PARENT: state.agentId,
    HIVE_ROLE: agentRole,
    HIVE_INTERACTIVE: interactive ? "true" : "false",
  };

  const spawnResult = await spawnPane(pi, {
    cwd: agentCwd,
    piArgs,
    paneCount: state.paneCount,
    env,
  });

  if (!spawnResult.ok) {
    return {
      ok: false,
      message: `Failed to spawn agent "${agentName}". ${spawnResult.error || "Is Windows Terminal available?"}`,
      details: { spawn: spawnResult },
    };
  }

  state.paneCount++;

  return {
    ok: true,
    message: `Spawned agent "${agentName}" (${agentRole}).${params.task ? ` Initial task: "${params.task}"` : ""}`,
    details: {
      agentId,
      agentName,
      agentRole,
      cwd: agentCwd,
      task: params.task,
      interactive,
      spawn: {
        command: spawnResult.command,
        exitCode: spawnResult.exitCode,
      },
    },
  };
}
