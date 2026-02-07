/**
 * Reservation tools:
 * - hive_reserve
 * - hive_release
 */

import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { BrokerMessage } from "../broker/protocol.js";
import type { HiveState } from "../index.js";

interface ReserveParams {
  paths: string[];
  reason?: string;
}

interface ReleaseParams {
  paths?: string[];
}

function normalizeReservationPath(input: string, cwd: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";

  const isDir = /[\\/]$/.test(raw);
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  let normalized = absolute.replace(/\\/g, "/").replace(/\/+/g, "/");

  if (isDir) {
    normalized = normalized.replace(/\/+$/, "") + "/";
  } else {
    normalized = normalized.replace(/\/+$/, "");
  }

  if (!normalized) return isDir ? "/" : "";
  return normalized;
}

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function registerReservationTools(pi: ExtensionAPI, state: HiveState): void {
  pi.registerTool({
    name: "hive_reserve",
    label: "Hive Reserve",
    description: "Reserve files/directories to block other agents from editing them.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "File or directory path. Directories should end with /" })),
      reason: Type.Optional(Type.String({ description: "Optional reservation reason" })),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const client = state.client;
      if (!client || !client.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }],
          details: {},
          isError: true,
        };
      }

      const params = input as ReserveParams;
      const normalizedPaths = dedupe(
        (params.paths || [])
          .map((p) => normalizeReservationPath(p, ctx.cwd))
          .filter((p) => !!p)
      );

      if (normalizedPaths.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No valid paths provided." }],
          details: {},
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: `Reserving ${normalizedPaths.length} path(s)...` }],
        details: {},
      });

      client.reserve(normalizedPaths, params.reason);

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error("Timed out waiting for reservation update"));
          }, 4000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type === "reservations_updated") {
              const mine = msg.reservations[state.agentId];
              const minePaths = new Set(mine?.paths || []);
              const allPresent = normalizedPaths.every((p) => minePaths.has(p));
              if (allPresent) {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                client.offMessage(handler);
                resolve();
              }
              return;
            }

            if (msg.type === "error" && msg.message.toLowerCase().includes("reserved")) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              reject(new Error(msg.message));
            }
          };

          client.onMessage(handler);
        });

        return {
          content: [{ type: "text" as const, text: `Reserved ${normalizedPaths.length} path(s).` }],
          details: { paths: normalizedPaths, reason: params.reason },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Reservation failed: ${err.message}` }],
          details: { paths: normalizedPaths, reason: params.reason, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as ReserveParams;
      const count = args.paths?.length || 0;
      const line = `${count} path${count === 1 ? "" : "s"}`;
      return new Text(theme.fg("toolTitle", theme.bold("hive_reserve ")) + theme.fg("accent", line), 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ " + content), 0, 0);
    },
  });

  pi.registerTool({
    name: "hive_release",
    label: "Hive Release",
    description: "Release reserved files/directories. Omit paths to release everything.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String({ description: "Specific paths to release" }))),
    }) as any,

    async execute(toolCallId, input, signal, onUpdate, ctx) {
      const client = state.client;
      if (!client || !client.isConnected()) {
        return {
          content: [{ type: "text" as const, text: "Error: Not connected to hive broker" }],
          details: {},
          isError: true,
        };
      }

      const params = input as ReleaseParams;
      const normalizedPaths = params.paths
        ? dedupe(params.paths.map((p) => normalizeReservationPath(p, ctx.cwd)).filter((p) => !!p))
        : undefined;

      client.release(normalizedPaths);

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            client.offMessage(handler);
            reject(new Error("Timed out waiting for release update"));
          }, 4000);

          const onAbort = () => {
            clearTimeout(timer);
            client.offMessage(handler);
            reject(new Error("Aborted"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });

          const handler = (msg: BrokerMessage) => {
            if (msg.type !== "reservations_updated") return;

            const mine = msg.reservations[state.agentId];
            const minePaths = new Set(mine?.paths || []);

            if (!normalizedPaths || normalizedPaths.length === 0) {
              if (!mine || mine.paths.length === 0) {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                client.offMessage(handler);
                resolve();
              }
              return;
            }

            const allRemoved = normalizedPaths.every((p) => !minePaths.has(p));
            if (allRemoved) {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              client.offMessage(handler);
              resolve();
            }
          };

          client.onMessage(handler);
        });

        return {
          content: [{ type: "text" as const, text: normalizedPaths?.length ? `Released ${normalizedPaths.length} path(s).` : "Released all reservations." }],
          details: { paths: normalizedPaths || null },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Release failed: ${err.message}` }],
          details: { paths: normalizedPaths || null, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(input: any, theme: any) {
      const args = input as ReleaseParams;
      const label = args.paths?.length ? `${args.paths.length} path${args.paths.length === 1 ? "" : "s"}` : "all";
      return new Text(theme.fg("toolTitle", theme.bold("hive_release ")) + theme.fg("accent", label), 0, 0);
    },

    renderResult(result: any, opts: any, theme: any) {
      const text = result.content?.[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      if (result.isError) return new Text(theme.fg("error", "✗ " + content), 0, 0);
      return new Text(theme.fg("success", "✓ " + content), 0, 0);
    },
  });
}
