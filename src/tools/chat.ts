/**
 * hive_chat — DM an agent and wait for their response.
 */

import * as crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface ChatParams {
  agent: string;
  message: string;
  timeout?: number;
}

export function registerChatTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_chat",
    label: "Hive Chat",
    description: [
      "Send a direct message to another agent on the hive network and wait for their response.",
      "The target agent's LLM will process your message and respond.",
      "Use hive_agents() first to see who's online.",
      "For messages that don't need a response, use hive_send instead.",
    ].join(" "),
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the target agent" }),
      message: Type.String({ description: "Message to send" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120)" })),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as ChatParams;
      const client = state.client;
      if (!client || !client.isConnected()) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }], details: {} , isError: true };
      }

      const target = client.getAgentByName(params.agent);
      if (!target) {
        const known = client.getKnownAgents().filter(a => a.name !== state.agentName).map(a => a.name).join(", ");
        return {
          content: [{ type: "text" as const, text: `Agent "${params.agent}" is not online. Available: ${known || "none"}` }],
          details: {}, isError: true,
        };
      }

      const correlationId = crypto.randomUUID();
      const timeoutMs = (params.timeout || 120) * 1000;

      client.send({ type: "dm", to: params.agent, content: params.message, correlationId });

      onUpdate?.({ content: [{ type: "text" as const, text: `Waiting for response from ${params.agent}...` }], details: {} });

      try {
        const response = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error(`Timeout: ${params.agent} did not respond within ${params.timeout || 120}s`));
          }, timeoutMs);

          const onAbort = () => { clearTimeout(timer); client.offMessage(handler); reject(new Error("Aborted")); };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type === "dm_response" && msg.correlationId === correlationId) {
              clearTimeout(timer); signal?.removeEventListener("abort", onAbort); client.offMessage(handler);
              resolve(msg.content);
            } else if (msg.type === "error" && msg.correlationId === correlationId) {
              clearTimeout(timer); signal?.removeEventListener("abort", onAbort); client.offMessage(handler);
              reject(new Error(msg.message));
            } else if (msg.type === "agent_left" && msg.name === params.agent) {
              clearTimeout(timer); signal?.removeEventListener("abort", onAbort); client.offMessage(handler);
              reject(new Error(`Agent "${params.agent}" disconnected before responding`));
            }
          };
          client.onMessage(handler);
        });

        return {
          content: [{ type: "text" as const, text: response }],
          details: { agent: params.agent, correlationId, mode: "chat" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Chat with ${params.agent} failed: ${err.message}` }],
          details: { agent: params.agent, correlationId, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as ChatParams;
      const text = theme.fg("toolTitle", theme.bold("hive_chat ")) + theme.fg("accent", args.agent || "...") +
        "\n  " + theme.fg("dim", args.message ? (args.message.length > 80 ? args.message.slice(0, 80) + "..." : args.message) : "...");
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded }: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      const details = result.details;
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      const agentName = details?.agent || "agent";
      let display = theme.fg("success", "✓ ") + theme.fg("accent", agentName) + theme.fg("muted", " responded:");
      if (expanded) {
        display += "\n" + content;
      } else {
        display += "\n" + theme.fg("dim", content.length > 120 ? content.slice(0, 120) + "..." : content);
      }
      return new Text(display, 0, 0);
    },
  });
}
