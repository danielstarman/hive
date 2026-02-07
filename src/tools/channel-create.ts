/**
 * hive_channel_create — Create a channel and auto-join it.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface CreateChannelParams {
  channel: string;
}

function normalizeChannelName(raw: string): string {
  return (raw || "").trim().replace(/^#/, "");
}

export function registerChannelCreateTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_channel_create",
    label: "Hive Channel Create",
    description: "Create a named channel on the hive network. You auto-join the channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name to create" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as CreateChannelParams;
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

      client.send({ type: "channel_create", channel });

      try {
        const ok = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error(`Timed out creating #${channel}`));
          }, 3000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type === "channel_created" && msg.channel === channel) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              resolve(true);
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
          content: [{ type: "text" as const, text: `Created #${channel} and joined it.` }],
          details: { channel, ok },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to create #${channel}: ${err.message}` }],
          details: { channel, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as CreateChannelParams;
      return new Text(
        theme.fg("toolTitle", theme.bold("hive_channel_create ")) + theme.fg("accent", `#${normalizeChannelName(args.channel || "...")}`),
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
