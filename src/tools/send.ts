/**
 * hive_send — Fire-and-forget DM to another agent.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { HiveState } from "../index.js";

interface SendParams { agent: string; message: string; }

export function registerSendTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_send",
    label: "Hive Send",
    description: [
      "Send a fire-and-forget message to another agent on the hive network.",
      "The target agent will see the message but you won't wait for or receive a response.",
      "Use hive_chat instead if you need a response.",
    ].join(" "),
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the target agent" }),
      message: Type.String({ description: "Message to send" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as SendParams;
      const client = state.client;
      if (!client || !client.isConnected()) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }], details: {}, isError: true };
      }

      const target = client.getAgentByName(params.agent);
      if (!target) {
        const known = client.getKnownAgents().filter(a => a.name !== state.agentName).map(a => a.name).join(", ");
        return { content: [{ type: "text" as const, text: `Agent "${params.agent}" is not online. Available: ${known || "none"}` }], details: {}, isError: true };
      }

      client.send({ type: "dm", to: params.agent, content: params.message });
      return { content: [{ type: "text" as const, text: `Message sent to ${params.agent}.` }], details: { agent: params.agent, mode: "send" } };
    },

    renderCall(input: any, theme: any) {
      const args = input as SendParams;
      const text = theme.fg("toolTitle", theme.bold("hive_send ")) + theme.fg("accent", args.agent || "...") +
        "\n  " + theme.fg("dim", args.message ? (args.message.length > 80 ? args.message.slice(0, 80) + "..." : args.message) : "...");
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
