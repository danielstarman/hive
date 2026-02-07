/**
 * hive_channels — List all channels on the hive network.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { HiveState } from "../index.js";

export function registerChannelsTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_channels",
    label: "Hive Channels",
    description: "List all channels currently on the hive network with members and creator.",
    parameters: Type.Object({}) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const client = state.client;
      if (!client || !client.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }],
          details: {},
          isError: true,
        };
      }

      client.send({ type: "list_channels" });
      const channels: any[] = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          client.offMessage(handler);
          resolve([]);
        }, 2000);

        const handler = (msg: any) => {
          if (msg.type === "channel_list") {
            clearTimeout(timer);
            client.offMessage(handler);
            resolve(msg.channels || []);
          }
        };

        client.onMessage(handler);
      });

      if (channels.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No channels exist on the hive." }],
          details: { channels: [] },
        };
      }

      const idToName = new Map(client.getKnownAgents().map((a) => [a.id, a.name]));
      const lines = channels.map((ch: any) => {
        const members = (ch.members || [])
          .map((id: string) => idToName.get(id) || id)
          .join(", ");
        return `- #${ch.name} (by ${ch.createdBy}) — [${members || "no members"}]`;
      });

      return {
        content: [{ type: "text" as const, text: `Hive channels (${channels.length}):\n${lines.join("\n")}` }],
        details: { channels },
      };
    },

    renderCall(input: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("hive_channels")), 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", content), 0, 0);
    },
  });
}
