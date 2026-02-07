/**
 * hive_channel_send — Send a message to a channel.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface ChannelSendParams {
  channel: string;
  message: string;
}

function normalizeChannelName(raw: string): string {
  return (raw || "").trim().replace(/^#/, "");
}

export function registerChannelSendTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_channel_send",
    label: "Hive Channel Send",
    description: "Send a message to all members of a channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Target channel" }),
      message: Type.String({ description: "Message to send" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as ChannelSendParams;
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

      client.send({ type: "channel_send", channel, content: params.message });

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error(`Timed out sending to #${channel}`));
          }, 3000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type === "channel_sent" && msg.channel === channel) {
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
          content: [{ type: "text" as const, text: `Sent to #${channel}.` }],
          details: { channel, mode: "channel_send" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to send to #${channel}: ${err.message}` }],
          details: { channel, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as ChannelSendParams;
      const channel = normalizeChannelName(args.channel || "...");
      const preview = args.message ? (args.message.length > 80 ? args.message.slice(0, 80) + "..." : args.message) : "...";
      const text =
        theme.fg("toolTitle", theme.bold("hive_channel_send ")) +
        theme.fg("accent", `#${channel}`) +
        "\n  " +
        theme.fg("dim", preview);
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
