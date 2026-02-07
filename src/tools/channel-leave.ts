/**
 * hive_channel_leave — Leave a channel.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface LeaveChannelParams {
  channel: string;
}

function normalizeChannelName(raw: string): string {
  return (raw || "").trim().replace(/^#/, "");
}

export function registerChannelLeaveTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_channel_leave",
    label: "Hive Channel Leave",
    description: "Leave a hive channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name to leave" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as LeaveChannelParams;
      const client = state.client;

      if (!client || !client.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }],
          details: {},
          isError: true,
        };
      }

      const channel = normalizeChannelName(params.channel);
      if (!channel) {
        return {
          content: [{ type: "text" as const, text: "Channel name is required." }],
          details: {},
          isError: true,
        };
      }

      client.send({ type: "channel_leave", channel });

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error(`Timed out leaving #${channel}`));
          }, 3000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (
              msg.type === "channel_left" &&
              msg.channel === channel &&
              msg.agentName === state.agentName
            ) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              resolve();
              return;
            }

            if (msg.type === "error" && msg.message.includes(channel)) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              reject(new Error(msg.message));
            }
          };

          client.onMessage(handler);
        });

        return {
          content: [{ type: "text" as const, text: `Left #${channel}.` }],
          details: { channel },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to leave #${channel}: ${err.message}` }],
          details: { channel, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as LeaveChannelParams;
      return new Text(
        theme.fg("toolTitle", theme.bold("hive_channel_leave ")) + theme.fg("accent", `#${normalizeChannelName(args.channel || "...")}`),
        0,
        0
      );
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ " + content), 0, 0);
    },
  });
}
