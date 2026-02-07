/**
 * hive_spawn — Spawn a new agent in a Windows Terminal pane.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { spawnAgent, type SpawnAgentParams } from "./spawn-core.js";
import type { HiveState } from "../index.js";

export function registerSpawnTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_spawn",
    label: "Hive Spawn",
    description: [
      "Spawn a new agent in a Windows Terminal pane connected to the hive network.",
      "The agent gets its own pi instance with isolated context.",
      "Use 'task' parameter to give it an initial task.",
      "Interactive agents stay alive for ongoing conversation.",
    ].join(" "),
    parameters: Type.Object({
      name: Type.String({ description: "Display name for this agent on the network (must be unique)" }),
      role: Type.Optional(Type.String({ description: "Short description of the agent's role" })),
      task: Type.Optional(Type.String({ description: "Initial task/message sent to the agent on startup" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the agent (default: current directory)" })),
      systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for the agent persona" })),
      model: Type.Optional(Type.String({ description: "Model override (e.g. claude-haiku-4-5)" })),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool list override (e.g. read,grep,find,ls)" })),
      interactive: Type.Optional(Type.Boolean({ description: "Keep the agent alive for ongoing interaction (default: true)" })),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as SpawnAgentParams;
      const result = await spawnAgent(pi, state, ctx, params);

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: result.details || {},
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: result.message }],
        details: result.details || {},
      };
    },

    renderCall(input: any, theme: any) {
      const args = input as SpawnAgentParams;
      let text = theme.fg("toolTitle", theme.bold("hive_spawn ")) + theme.fg("accent", args.name || "...");
      if (args.role) text += theme.fg("muted", ` (${args.role})`);
      if (args.task) {
        const preview = args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task;
        text += "\n  " + theme.fg("dim", preview);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ " + content), 0, 0);
    },
  });
}
