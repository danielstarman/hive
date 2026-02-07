/**
 * hive_status — Update this agent's status on the network.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { HiveState } from "../index.js";

interface StatusParams { status: "idle" | "busy" | "done"; }

export function registerLifecycleTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_status",
    label: "Hive Status",
    description: [
      "Update your status on the hive network.",
      "Status auto-updates to 'busy' during work and 'idle' when done.",
      "Use this to manually set 'done' when you've completed your task.",
    ].join(" "),
    parameters: Type.Object({
      status: StringEnum(["idle", "busy", "done"] as const, {
        description: "New status. 'done' signals you've completed your assigned task.",
      }) as any,
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as StatusParams;
      const client = state.client;
      if (!client || !client.isConnected()) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }], details: {}, isError: true };
      }

      client.send({ type: "status_update", status: params.status });

      if (params.status === "done" && state.interactive === false) {
        setTimeout(() => {
          try {
            process.exit(0);
          } catch {
            /* ignore */
          }
        }, 1000);
      }

      return { content: [{ type: "text" as const, text: `Status updated to "${params.status}".` }], details: { status: params.status } };
    },

    renderCall(input: any, theme: any) {
      const args = input as StatusParams;
      return new Text(theme.fg("toolTitle", theme.bold("hive_status ")) + theme.fg("accent", args.status || "..."), 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("success", "✓ " + content), 0, 0);
    },
  });
}
