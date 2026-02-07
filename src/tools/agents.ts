/**
 * hive_agents — List all agents on the hive network.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { HiveState } from "../index.js";

export function registerAgentsTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_agents",
    label: "Hive Agents",
    description: "List all agents currently connected to the hive network with their name, role, status, and channels.",
    parameters: Type.Object({}) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const client = state.client;
      if (!client || !client.isConnected()) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }], details: {}, isError: true };
      }

      // Request fresh list from broker
      client.send({ type: "list_agents" });
      const agents: any[] = await new Promise(resolve => {
        const timer = setTimeout(() => { client.offMessage(handler); resolve(client.getKnownAgents()); }, 2000);
        const handler = (msg: any) => {
          if (msg.type === "agent_list") { clearTimeout(timer); client.offMessage(handler); resolve(msg.agents); }
        };
        client.onMessage(handler);
      });

      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: "No agents connected to the hive." }], details: { agents: [] } };
      }

      const lines = agents.map((a: any) => {
        const isSelf = a.name === state.agentName;
        const channels = a.channels.length > 0 ? ` [${a.channels.map((c: string) => "#" + c).join(", ")}]` : "";
        return `- ${a.name}${isSelf ? " (you)" : ""}: ${a.role} [${a.status}]${channels}`;
      });

      return {
        content: [{ type: "text" as const, text: `Hive agents (${agents.length}):\n${lines.join("\n")}` }],
        details: { agents },
      };
    },

    renderCall(input: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("hive_agents")), 0, 0);
    },

    renderResult(result: any, { expanded }: any, theme: any) {
      const agents = result.details?.agents || [];
      if (agents.length === 0) return new Text(theme.fg("muted", "No agents connected."), 0, 0);

      const lines = agents.map((a: any) => {
        const statusColor = a.status === "idle" ? "success" : a.status === "busy" ? "warning" : "muted";
        const channels = a.channels.length > 0 ? theme.fg("dim", ` [${a.channels.map((c: string) => "#" + c).join(", ")}]`) : "";
        return theme.fg("accent", a.name) + theme.fg("muted", ` (${a.role})`) + " " + theme.fg(statusColor, `[${a.status}]`) + channels;
      });

      return new Text(theme.fg("toolTitle", `Hive — ${agents.length} agents\n`) + lines.join("\n"), 0, 0);
    },
  });
}
