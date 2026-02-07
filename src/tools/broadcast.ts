/**
 * hive_broadcast — Send a message to all agents on the network.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { HiveState } from "../index.js";

interface BroadcastParams { message: string; }

export function registerBroadcastTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_broadcast",
    label: "Hive Broadcast",
    description: [
      "Broadcast a message to ALL agents on the hive network.",
      "Every connected agent will see this message.",
      "Use for announcements, status updates, or coordination.",
      "This is fire-and-forget — you won't receive individual responses.",
    ].join(" "),
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast to all agents" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as BroadcastParams;
      const client = state.client;
      if (!client || !client.isConnected()) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }], details: {}, isError: true };
      }

      const agentCount = client.getKnownAgents().filter(a => a.name !== state.agentName).length;
      client.send({ type: "broadcast", content: params.message });

      return {
        content: [{ type: "text" as const, text: `Broadcast sent to ${agentCount} agent${agentCount !== 1 ? "s" : ""}.` }],
        details: { mode: "broadcast", recipientCount: agentCount },
      };
    },

    renderCall(input: any, theme: any) {
      const args = input as BroadcastParams;
      const preview = args.message ? (args.message.length > 80 ? args.message.slice(0, 80) + "..." : args.message) : "...";
      return new Text(theme.fg("toolTitle", theme.bold("hive_broadcast ")) + "\n  " + theme.fg("dim", preview), 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", content), 0, 0);
    },
  });
}
