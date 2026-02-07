/**
 * hive_rename — Change this agent's display name.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface RenameParams {
  name: string;
}

export function registerRenameTool(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_rename",
    label: "Hive Rename",
    description: "Change your display name on the hive network.",
    parameters: Type.Object({
      name: Type.String({ description: "New unique name" }),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const params = input as RenameParams;
      const client = state.client;

      if (!client || !client.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }],
          details: {},
          isError: true,
        };
      }

      const newName = (params.name || "").trim();
      if (!newName) {
        return {
          content: [{ type: "text" as const, text: "Name is required." }],
          details: {},
          isError: true,
        };
      }

      const oldName = state.agentName;

      // Fast local guard for obvious conflicts.
      const taken = client.getKnownAgents().find((a) => a.name === newName && a.id !== state.agentId);
      if (taken) {
        return {
          content: [{ type: "text" as const, text: `Name "${newName}" is already taken.` }],
          details: { oldName, newName },
          isError: true,
        };
      }

      client.send({ type: "rename", name: newName });

      try {
        const renamed = await new Promise<{ oldName: string; newName: string }>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error(`Timed out renaming to "${newName}"`));
          }, 4000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type === "agent_renamed" && msg.id === state.agentId && msg.newName === newName) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              resolve({ oldName: msg.oldName, newName: msg.newName });
              return;
            }

            if (msg.type === "error" && msg.message.toLowerCase().includes("name")) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              reject(new Error(msg.message));
            }
          };

          client.onMessage(handler);
        });

        // Keep local state in sync immediately.
        state.agentName = renamed.newName;

        return {
          content: [{ type: "text" as const, text: `Renamed from "${renamed.oldName}" to "${renamed.newName}".` }],
          details: renamed,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Rename failed: ${err.message}` }],
          details: { oldName, newName, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as RenameParams;
      return new Text(
        theme.fg("toolTitle", theme.bold("hive_rename ")) + theme.fg("accent", args.name || "..."),
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
