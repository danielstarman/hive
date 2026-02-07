/**
 * Hive — Multi-agent chat network for pi.
 *
 * Entry point: detects hub vs child mode, starts broker or connects.
 *
 * Discovery order for broker:
 *   1. --hive-broker CLI flag (explicit URL)
 *   2. HIVE_BROKER environment variable
 *   3. os.tmpdir()/pi-hive/broker.json shared discovery file
 *   4. None found → start as hub (launch broker)
 *
 * Agent identity passed via:
 *   - CLI flags: --hive-name, --hive-id, --hive-parent, --hive-role
 *   - Env vars: HIVE_NAME, HIVE_ID, HIVE_PARENT, HIVE_ROLE (fallback)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { HiveBroker } from "./broker/server.js";
import { HiveClient } from "./client/connection.js";
import { Inbox } from "./client/inbox.js";
import { registerSpawnTool } from "./tools/spawn.js";
import { registerChatTool } from "./tools/chat.js";
import { registerSendTool } from "./tools/send.js";
import { registerBroadcastTool } from "./tools/broadcast.js";
import { registerAgentsTool } from "./tools/agents.js";
import { registerLifecycleTool } from "./tools/lifecycle.js";
import { registerRenameTool } from "./tools/rename.js";
import { registerReservationTools } from "./tools/reservations.js";
import { registerChannelsTool } from "./tools/channels.js";
import { registerChannelCreateTool } from "./tools/channel-create.js";
import { registerChannelJoinTool } from "./tools/channel-join.js";
import { registerChannelLeaveTool } from "./tools/channel-leave.js";
import { registerChannelSendTool } from "./tools/channel-send.js";
import { spawnAgent } from "./tools/spawn-core.js";
import type { BrokerConfig, ChannelInfo, ReservationMap } from "./types.js";

const MAX_ACTIVITY_EVENTS = 5;
const ACTIVE_WINDOW_MS = 30_000;
const STUCK_WINDOW_MS = 5 * 60_000;

/** Shared mutable state accessible by all tools and handlers. */
export interface HiveState {
  client: HiveClient | null;
  broker: HiveBroker | null;
  inbox: Inbox | null;
  agentId: string;
  agentName: string;
  agentRole: string;
  isHub: boolean;
  interactive: boolean;
  extensionPath: string;
  brokerPort: number;
  paneCount: number;
  tempFiles: { dir: string; file: string }[];
  activityFeedEnabled: boolean;
  activityFeed: string[];
  lastActivityAt: string;
  toolCallCount: number;
  recentToolCalls: string[];
  lastPresenceUpdate: number;
  sessionStartedAt: number;
  notifiedStuck: Set<string>;
  stuckCheckInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Shared broker config path in the system temp directory.
 */
function getBrokerConfigDir(): string {
  return path.join(os.tmpdir(), "pi-hive");
}

function getBrokerConfigPath(): string {
  return path.join(getBrokerConfigDir(), "broker.json");
}

/**
 * Load broker config from os.tmpdir()/pi-hive/broker.json.
 */
function findBrokerConfig(): BrokerConfig | null {
  const candidate = getBrokerConfigPath();
  try {
    const data = fs.readFileSync(candidate, "utf-8");
    const config = JSON.parse(data) as BrokerConfig;
    if (config.port && config.pid) {
      return config;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Read a config value from: CLI flag → env var → default
 */
function getConfig(
  pi: ExtensionAPI,
  flagName: string,
  envName: string,
  defaultValue: string
): string {
  const fromFlag = pi.getFlag(`--${flagName}`) as string;
  if (fromFlag) return fromFlag;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  return defaultValue;
}

function getBooleanConfig(
  pi: ExtensionAPI,
  flagName: string,
  envName: string,
  defaultValue: boolean
): boolean {
  const raw = getConfig(pi, flagName, envName, defaultValue ? "true" : "false").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function splitArgs(input: string): string[] {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function truncate(text: string, maxLen = 80): string {
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function nowStamp(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function addActivity(ctx: any, state: HiveState, line: string): void {
  state.activityFeed.push(`${nowStamp()} ${line}`);
  if (state.activityFeed.length > 50) {
    state.activityFeed = state.activityFeed.slice(-50);
  }

  if (ctx.hasUI && state.activityFeedEnabled) {
    updateActivityWidget(ctx, state);
  }
}

function updateActivityWidget(ctx: any, state: HiveState): void {
  if (!ctx.hasUI) return;

  if (!state.activityFeedEnabled) {
    if (typeof ctx.ui.removeWidget === "function") {
      try {
        ctx.ui.removeWidget("hive-feed");
      } catch {
        /* ignore */
      }
    } else {
      ctx.ui.setWidget("hive-feed", [], { placement: "aboveEditor" });
    }
    return;
  }

  const recent = state.activityFeed.slice(-MAX_ACTIVITY_EVENTS);
  const lines = recent.length > 0 ? recent : ["(no activity yet)"];
  ctx.ui.setWidget("hive-feed", ["📡 Hive feed", ...lines], { placement: "aboveEditor" });
}

async function requestChannels(state: HiveState): Promise<ChannelInfo[]> {
  const client = state.client;
  if (!client || !client.isConnected()) return [];

  client.send({ type: "list_channels" });

  return await new Promise((resolve) => {
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
}

function normalizeReservationPath(raw: string, cwd?: string): string {
  let value = (raw || "").trim();
  if (!value) return "";

  const isDir = /[\\/]$/.test(value);
  if (cwd && !path.isAbsolute(value)) {
    value = path.resolve(cwd, value);
  }

  value = value.replace(/\\/g, "/").replace(/\/+/g, "/");

  if (isDir) {
    value = value.replace(/\/+$/, "") + "/";
  } else {
    value = value.replace(/\/+$/, "");
  }

  if (!value) return isDir ? "/" : "";
  return value;
}

function reservationPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;

  const aDir = a.endsWith("/");
  const bDir = b.endsWith("/");

  if (aDir && (b.startsWith(a) || b === a.slice(0, -1))) return true;
  if (bDir && (a.startsWith(b) || a === b.slice(0, -1))) return true;

  return false;
}

function findReservationConflict(
  reservations: ReservationMap,
  targetPath: string,
  selfAgentId: string
): { ownerId: string; reason?: string } | null {
  for (const [ownerId, reservation] of Object.entries(reservations)) {
    if (ownerId === selfAgentId) continue;
    for (const reservedPath of reservation.paths || []) {
      if (reservationPathsOverlap(targetPath, reservedPath)) {
        return { ownerId, reason: reservation.reason };
      }
    }
  }
  return null;
}

function getPresenceIndicator(status: "idle" | "busy" | "done", lastActivityAt?: string): string {
  if (!lastActivityAt) {
    return status === "busy" ? "🔴" : "🟠";
  }

  const ts = Date.parse(lastActivityAt);
  if (Number.isNaN(ts)) {
    return status === "busy" ? "🔴" : "🟠";
  }

  const ageMs = Date.now() - ts;
  if (ageMs <= ACTIVE_WINDOW_MS) return "🟢";
  if (ageMs <= STUCK_WINDOW_MS) return "🟡";
  return status === "busy" ? "🔴" : "🟠";
}

function computeAutoStatusMessage(state: HiveState, toolName: string): string | undefined {
  const sessionAgeMs = Date.now() - state.sessionStartedAt;
  if (sessionAgeMs < 30_000) {
    return "just arrived";
  }

  const editCount = state.recentToolCalls.filter((t) => t === "edit").length;
  if (editCount >= 5) {
    return "on fire 🔥";
  }

  const bashCount = state.recentToolCalls.filter((t) => t === "bash").length;
  if (bashCount >= 3) {
    return "debugging...";
  }

  if (toolName === "read") {
    return "exploring";
  }

  if (toolName === "edit" || toolName === "write") {
    return "deep in code";
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  // ── CLI Flags ───────────────────────────────────────────────────────

  pi.registerFlag("hive-broker", {
    description: "WebSocket broker URL (auto-discovered from broker.json if not set)",
    type: "string",
    default: "",
  });

  pi.registerFlag("hive-name", {
    description: "Agent name on the hive network",
    type: "string",
    default: "",
  });

  pi.registerFlag("hive-id", {
    description: "Agent ID (UUID)",
    type: "string",
    default: "",
  });

  pi.registerFlag("hive-parent", {
    description: "Parent agent ID (who spawned this agent)",
    type: "string",
    default: "",
  });

  pi.registerFlag("hive-role", {
    description: "Agent role description",
    type: "string",
    default: "",
  });

  pi.registerFlag("hive-interactive", {
    description: "Whether this agent should stay alive for ongoing conversation",
    type: "string",
    default: "",
  });

  // ── Shared State ────────────────────────────────────────────────────

  const state: HiveState = {
    client: null,
    broker: null,
    inbox: null,
    agentId: "",
    agentName: "",
    agentRole: "",
    isHub: false,
    interactive: true,
    extensionPath: path.resolve(__dirname, "index.ts"),
    brokerPort: 0,
    paneCount: 0,
    tempFiles: [],
    activityFeedEnabled: false,
    activityFeed: [],
    lastActivityAt: new Date().toISOString(),
    toolCallCount: 0,
    recentToolCalls: [],
    lastPresenceUpdate: 0,
    sessionStartedAt: Date.now(),
    notifiedStuck: new Set<string>(),
    stuckCheckInterval: null,
  };

  // Read agent identity from flags or env vars
  state.agentId = getConfig(pi, "hive-id", "HIVE_ID", crypto.randomUUID());
  state.agentName = getConfig(pi, "hive-name", "HIVE_NAME", "");
  state.agentRole = getConfig(pi, "hive-role", "HIVE_ROLE", "");
  state.interactive = getBooleanConfig(pi, "hive-interactive", "HIVE_INTERACTIVE", true);

  // ── Register Tools ──────────────────────────────────────────────────

  registerSpawnTool(pi, state);
  registerChatTool(pi, state);
  registerSendTool(pi, state);
  registerBroadcastTool(pi, state);
  registerAgentsTool(pi, state);
  registerChannelsTool(pi, state);
  registerChannelCreateTool(pi, state);
  registerChannelJoinTool(pi, state);
  registerChannelLeaveTool(pi, state);
  registerChannelSendTool(pi, state);
  registerRenameTool(pi, state);
  registerReservationTools(pi, state);
  registerLifecycleTool(pi, state);

  // ── Session Start — Discover Broker & Connect ───────────────────────

  pi.on("session_start", async (_event, ctx) => {
    state.sessionStartedAt = Date.now();
    state.lastActivityAt = new Date(state.sessionStartedAt).toISOString();
    state.lastPresenceUpdate = 0;
    state.toolCallCount = 0;
    state.recentToolCalls = [];
    state.notifiedStuck.clear();

    try {
      // ── Discover broker URL ──────────────────────────────────────
      let brokerUrl = getConfig(pi, "hive-broker", "HIVE_BROKER", "");

      if (!brokerUrl) {
        // Try to find broker.json
        const config = findBrokerConfig();
        if (config) {
          brokerUrl = `ws://127.0.0.1:${config.port}`;
        }
      }

      // Determine identity defaults based on mode
      if (!brokerUrl) {
        // No broker found → we are the hub
        state.isHub = true;
        state.interactive = true;
        if (!state.agentName) state.agentName = "hub";
        if (!state.agentRole) state.agentRole = "hub — human operator";
      } else {
        // Broker found → we are a child
        state.isHub = false;
        if (!state.agentName) state.agentName = "agent-" + state.agentId.slice(0, 8);
        if (!state.agentRole) state.agentRole = "agent";
      }

      if (state.isHub) {
        // ── Hub Mode: Start broker + connect ──────────────────────
        const broker = new HiveBroker();
        const port = await broker.start();
        state.broker = broker;
        state.brokerPort = port;

        // Write broker.json so children can discover us.
        const hiveDir = getBrokerConfigDir();
        fs.mkdirSync(hiveDir, { recursive: true });
        const brokerConfig: BrokerConfig = {
          port,
          pid: process.pid,
          hubId: state.agentId,
          startedAt: Date.now(),
        };
        fs.writeFileSync(getBrokerConfigPath(), JSON.stringify(brokerConfig, null, 2));

        // Connect as client to our own broker
        const client = new HiveClient();
        await client.connect(`ws://127.0.0.1:${port}`);
        state.client = client;

        client.register({
          id: state.agentId,
          name: state.agentName,
          role: state.agentRole,
          cwd: ctx.cwd,
          interactive: true,
        });

        state.inbox = new Inbox(pi, client, state.agentName);
        setupMessageHandlers(client, state, ctx);

        if (state.stuckCheckInterval) {
          clearInterval(state.stuckCheckInterval);
        }
        state.stuckCheckInterval = setInterval(() => {
          if (!state.client?.isConnected() || !ctx.hasUI) return;

          const now = Date.now();
          for (const agent of state.client.getKnownAgents()) {
            if (agent.id === state.agentId) continue;

            const lastActivityTs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : NaN;
            const idleTooLong = Number.isNaN(lastActivityTs) || now - lastActivityTs > STUCK_WINDOW_MS;

            if (agent.status === "busy" && idleTooLong) {
              if (!state.notifiedStuck.has(agent.id)) {
                state.notifiedStuck.add(agent.id);
                ctx.ui.notify(`⚠️ ${agent.name} may be stuck (idle for 5m while busy)`, "info");
              }
            } else {
              state.notifiedStuck.delete(agent.id);
            }
          }
        }, 60_000);

        if (ctx.hasUI) {
          ctx.ui.notify(`🐝 Hive broker started on port ${port}`, "info");
          setNameplate(ctx, state);
          if (state.activityFeedEnabled) updateActivityWidget(ctx, state);
        }
      } else {
        // ── Child Mode: Connect to existing broker ────────────────
        const client = new HiveClient();

        try {
          await client.connect(brokerUrl);
        } catch (err: any) {
          if (ctx.hasUI) {
            ctx.ui.notify(`🐝 Could not connect to broker at ${brokerUrl}: ${err.message}`, "error");
          }
          return;
        }

        state.client = client;

        try {
          const url = new URL(brokerUrl);
          state.brokerPort = parseInt(url.port, 10);
        } catch {
          /* ignore */
        }

        const parentId = getConfig(pi, "hive-parent", "HIVE_PARENT", "");
        client.register({
          id: state.agentId,
          name: state.agentName,
          role: state.agentRole,
          parentId: parentId || undefined,
          cwd: ctx.cwd,
          interactive: state.interactive,
        });

        state.inbox = new Inbox(pi, client, state.agentName);
        setupMessageHandlers(client, state, ctx);

        if (state.stuckCheckInterval) {
          clearInterval(state.stuckCheckInterval);
          state.stuckCheckInterval = null;
        }

        if (ctx.hasUI) {
          ctx.ui.notify(`🐝 Connected to hive as "${state.agentName}"`, "info");
          setNameplate(ctx, state);
          if (state.activityFeedEnabled) updateActivityWidget(ctx, state);
        }
      }
    } catch (err: any) {
      if (ctx.hasUI) {
        ctx.ui.notify(`🐝 Hive startup failed: ${err.message}`, "error");
      }
    }
  });

  // ── Agent Lifecycle — Auto Status Updates ───────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    state.inbox?.onAgentStart();
    if (state.client?.isConnected()) {
      state.client.send({ type: "status_update", status: "busy" });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    state.inbox?.onAgentEnd(event.messages);
    if (state.client?.isConnected()) {
      state.client.send({ type: "status_update", status: "idle" });
    }
  });

  // ── Tool Call Hook: Presence + Reservation Write Protection ────────

  pi.on("tool_call", async (event, ctx) => {
    const toolName = String((event as any)?.toolName || (event as any)?.name || "").trim();
    const nowMs = Date.now();

    // Rich presence activity tracking (all tools)
    state.lastActivityAt = new Date(nowMs).toISOString();
    state.toolCallCount++;
    if (toolName) {
      state.recentToolCalls.push(toolName);
      if (state.recentToolCalls.length > 10) {
        state.recentToolCalls = state.recentToolCalls.slice(-10);
      }
    }

    const client = state.client;
    if (client?.isConnected() && nowMs - state.lastPresenceUpdate >= 10_000) {
      const statusMessage = computeAutoStatusMessage(state, toolName);
      client.sendPresence(statusMessage);
      state.lastPresenceUpdate = nowMs;
    }

    // Reservation enforcement for write-capable tools
    if (toolName !== "edit" && toolName !== "write") {
      return;
    }

    if (!client || !client.isConnected()) {
      return;
    }

    const inputPath = (event as any)?.input?.path;
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      return;
    }

    const targetPath = normalizeReservationPath(inputPath, ctx.cwd);
    if (!targetPath) return;

    const reservations = client.getReservations();
    const conflict = findReservationConflict(reservations, targetPath, state.agentId);
    if (!conflict) return;

    const owner = client.getKnownAgents().find((a) => a.id === conflict.ownerId);
    const ownerName = owner?.name || conflict.ownerId;
    const reasonSuffix = conflict.reason ? `: ${conflict.reason}` : "";

    return {
      block: true,
      reason: `File reserved by ${ownerName}${reasonSuffix}`,
    };
  });

  // ── System Prompt Injection ─────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.client?.isConnected()) return;

    const agents = state.client.getKnownAgents();
    const otherAgents = agents.filter((a) => a.name !== state.agentName);

    let hiveContext = `\n\n## Hive Network\n\n`;
    hiveContext += `You are agent "${state.agentName}" on a hive chat network.\n\n`;

    if (otherAgents.length > 0) {
      hiveContext += `### Online Agents\n`;
      for (const a of otherAgents) {
        const channels = a.channels.length > 0 ? ` (channels: ${a.channels.map((c) => "#" + c).join(", ")})` : "";
        hiveContext += `- **${a.name}**: ${a.role} [${a.status}]${channels}\n`;
      }
      hiveContext += `\n`;
    } else {
      hiveContext += `No other agents are online.\n\n`;
    }

    hiveContext += `### Communication Tools\n`;
    hiveContext += `- \`hive_chat(agent, message)\` — Ask an agent something and wait for their response\n`;
    hiveContext += `- \`hive_send(agent, message)\` — Send a message without waiting\n`;
    hiveContext += `- \`hive_broadcast(message)\` — Message all agents\n`;
    hiveContext += `- \`hive_channel_create(channel)\` — Create and join a channel\n`;
    hiveContext += `- \`hive_channel_join(channel)\` — Join an existing channel\n`;
    hiveContext += `- \`hive_channel_leave(channel)\` — Leave a channel\n`;
    hiveContext += `- \`hive_channel_send(channel, message)\` — Send to channel members\n`;
    hiveContext += `- \`hive_channels()\` — List channels\n`;
    hiveContext += `- \`hive_agents()\` — See who's online\n`;
    hiveContext += `- \`hive_rename(name)\` — Change your display name\n`;
    hiveContext += `- \`hive_reserve(paths, reason?)\` — Reserve files/directories for exclusive edits\n`;
    hiveContext += `- \`hive_release(paths?)\` — Release reservations (specific or all)\n`;
    hiveContext += `- \`hive_status(status)\` — Update your status\n`;
    hiveContext += `- \`hive_spawn(name, ...)\` — Spawn a new agent in a terminal pane\n`;
    hiveContext += `\n`;
    hiveContext += `When you receive a message from another agent (prefixed with [From ...]:), respond helpfully and concisely.\n`;

    return { systemPrompt: event.systemPrompt + hiveContext };
  });

  // ── Commands ────────────────────────────────────────────────────────

  pi.registerCommand("hive", {
    description: "Show hive network overview",
    handler: async (args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }
      const agents = state.client.getKnownAgents();
      const lines = agents.map((a) => {
        const isSelf = a.name === state.agentName;
        const status = a.status === "idle" ? "🟢" : a.status === "busy" ? "🟡" : "⚪";
        const channels = a.channels.length > 0 ? ` [${a.channels.map((c) => "#" + c).join(", ")}]` : "";
        return `${status} ${a.name}${isSelf ? " (you)" : ""} — ${a.role}${channels}`;
      });
      ctx.ui.notify(`🐝 Hive Network (port ${state.brokerPort})\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("hive:agents", {
    description: "List hive agents",
    handler: async (args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }
      const agents = state.client.getKnownAgents();
      if (agents.length === 0) {
        ctx.ui.notify("No agents connected", "info");
        return;
      }
      ctx.ui.notify(agents.map((a) => `${a.name} (${a.role}) [${a.status}]`).join("\n"), "info");
    },
  });

  pi.registerCommand("hive:channels", {
    description: "List channels and their members",
    handler: async (args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }

      const channels = await requestChannels(state);
      if (channels.length === 0) {
        ctx.ui.notify("No channels exist.", "info");
        return;
      }

      const idToName = new Map(state.client.getKnownAgents().map((a) => [a.id, a.name]));
      const lines = channels.map((ch) => {
        const members = ch.members.map((id) => idToName.get(id) || id).join(", ");
        return `#${ch.name} (by ${ch.createdBy}) — [${members || "no members"}]`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("hive:reservations", {
    description: "Show current file reservations",
    handler: async (_args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }

      const reservations = state.client.getReservations();
      const entries = Object.entries(reservations);
      if (entries.length === 0) {
        ctx.ui.notify("No active reservations.", "info");
        return;
      }

      const idToName = new Map(state.client.getKnownAgents().map((a) => [a.id, a.name]));
      const lines = entries.map(([agentId, reservation]) => {
        const owner = idToName.get(agentId) || agentId;
        const reason = reservation.reason ? ` — ${reservation.reason}` : "";
        return `${owner}: ${reservation.paths.join(", ")}${reason}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("hive:spawn", {
    description: "Spawn a new hive agent in a pane",
    handler: async (args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }

      const parts = splitArgs((args || "").trim());
      if (parts.length === 0) {
        ctx.ui.notify("Usage: /hive:spawn <name> [task]", "info");
        return;
      }

      const name = parts[0];
      const task = parts.slice(1).join(" ").trim() || undefined;
      const result = await spawnAgent(pi, state, ctx, { name, task });

      if (!result.ok) {
        ctx.ui.notify(result.message, "error");
        return;
      }

      ctx.ui.notify(result.message, "info");
      addActivity(ctx, state, `➕ spawned ${name}${task ? ` — ${truncate(task, 60)}` : ""}`);
    },
  });

  pi.registerCommand("hive:kill", {
    description: "Disconnect an agent from the hive",
    handler: async (args, ctx) => {
      const name = (args || "").trim();
      if (!name) {
        ctx.ui.notify("Usage: /hive:kill <name>", "info");
        return;
      }

      if (!state.isHub || !state.broker) {
        ctx.ui.notify("/hive:kill is only available on the hub.", "error");
        return;
      }

      if (name === state.agentName) {
        ctx.ui.notify("Cannot kill yourself.", "error");
        return;
      }

      const ok = state.broker.disconnectAgentByName(name);
      if (!ok) {
        ctx.ui.notify(`Agent "${name}" is not online.`, "error");
        return;
      }

      ctx.ui.notify(`Disconnected "${name}" from hive.`, "info");
      addActivity(ctx, state, `🛑 disconnected ${name}`);
    },
  });

  pi.registerCommand("hive:feed", {
    description: "Toggle hive activity feed widget",
    handler: async (_args, ctx) => {
      state.activityFeedEnabled = !state.activityFeedEnabled;
      updateActivityWidget(ctx, state);
      ctx.ui.notify(
        state.activityFeedEnabled ? "Hive activity feed enabled." : "Hive activity feed hidden.",
        "info"
      );
    },
  });

  pi.registerCommand("hive:broadcast", {
    description: "Broadcast a message to all agents",
    handler: async (args, ctx) => {
      if (!state.client?.isConnected()) {
        ctx.ui.notify("Not connected to hive", "error");
        return;
      }
      if (!args) {
        ctx.ui.notify("Usage: /hive:broadcast <message>", "info");
        return;
      }
      state.client.send({ type: "broadcast", content: args });
      ctx.ui.notify(`Broadcast sent: ${args}`, "info");
      addActivity(ctx, state, `📢 broadcast: ${truncate(args, 80)}`);
    },
  });

  // ── Shutdown ────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.stuckCheckInterval) {
      clearInterval(state.stuckCheckInterval);
      state.stuckCheckInterval = null;
    }

    // Clean up temp files
    for (const tmp of state.tempFiles) {
      try {
        fs.unlinkSync(tmp.file);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(tmp.dir);
      } catch {
        /* ignore */
      }
    }

    // Disconnect client
    if (state.client) {
      state.client.close();
      state.client = null;
    }

    // Stop broker (if hub)
    if (state.broker) {
      state.broker.stop();
      state.broker = null;

      // Clean up broker.json
      try {
        const brokerJsonPath = getBrokerConfigPath();
        if (fs.existsSync(brokerJsonPath)) {
          fs.unlinkSync(brokerJsonPath);
        }
        const brokerDir = getBrokerConfigDir();
        if (fs.existsSync(brokerDir) && fs.readdirSync(brokerDir).length === 0) {
          fs.rmdirSync(brokerDir);
        }
      } catch {
        /* ignore */
      }
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Set the agent's nameplate — visible identity across terminal title,
 * widget header, and status bar. Called on connect and on network changes.
 */
function setNameplate(ctx: any, state: HiveState): void {
  if (!ctx.hasUI) return;

  const name = state.agentName;
  const role = state.agentRole;
  const isHub = state.isHub;
  const port = state.brokerPort;

  // Terminal/tab title — visible even when pane is small
  ctx.ui.setTitle(`🐝 ${name}${role ? ` — ${role}` : ""}`);

  // Status bar (footer) — persistent, compact
  if (isHub) {
    ctx.ui.setStatus("hive", `🐝 hive:${port} [${name}]`);
  } else {
    ctx.ui.setStatus("hive", `🐝 hive [${name}]`);
  }

  // Widget header — prominent nameplate above the editor
  updateNameplateWidget(ctx, state);
}

/**
 * Update the nameplate widget with current network state.
 * Shows: agent identity + online agent count + who's connected.
 */
function updateNameplateWidget(ctx: any, state: HiveState): void {
  if (!ctx.hasUI || !state.client) return;

  const others = state.client.getKnownAgents().filter((a) => a.name !== state.agentName);
  const onlineNames = others.map((a) => {
    const icon = getPresenceIndicator(a.status, a.lastActivityAt);
    const statusMessage = a.statusMessage ? ` "${a.statusMessage}"` : "";
    const channels = a.channels.length > 0 ? ` ${a.channels.map((c) => "#" + c).join(",")}` : "";
    return `${a.name} ${icon}${statusMessage}${channels}`;
  });

  const lines: string[] = [];
  const identity = `🐝 ${state.agentName} (${state.agentRole})`;

  if (others.length > 0) {
    lines.push(`${identity}  │  ${onlineNames.join("  ")}`);
  } else {
    lines.push(`${identity}  │  no other agents online`);
  }

  ctx.ui.setWidget("hive-nameplate", lines, { placement: "aboveEditor" });
}

function setupMessageHandlers(client: HiveClient, state: HiveState, ctx: any): void {
  client.onMessage((msg) => {
    if (msg.type === "dm" || msg.type === "broadcast" || msg.type === "channel_message") {
      state.inbox?.handleBrokerMessage(msg);
    }

    // Feed events
    if (msg.type === "dm") {
      addActivity(ctx, state, `📨 from ${msg.fromName}: ${truncate(msg.content, 70)}`);
    }
    if (msg.type === "broadcast") {
      addActivity(ctx, state, `📢 ${msg.fromName}: ${truncate(msg.content, 70)}`);
    }
    if (msg.type === "channel_message") {
      addActivity(ctx, state, `#${msg.channel} ${msg.fromName}: ${truncate(msg.content, 70)}`);
    }

    // Update nameplate + notifications on network changes
    if (msg.type === "agent_joined") {
      addActivity(ctx, state, `👋 ${msg.agent.name} joined`);
      if (ctx.hasUI) {
        ctx.ui.notify(`🐝 ${msg.agent.name} joined the hive (${msg.agent.role})`, "info");
        updateNameplateWidget(ctx, state);
      }
    }

    if (msg.type === "agent_left") {
      state.notifiedStuck.delete(msg.id);
      addActivity(ctx, state, `👋 ${msg.name} left`);
      if (ctx.hasUI) {
        ctx.ui.notify(`🐝 ${msg.name} left the hive`, "info");
        updateNameplateWidget(ctx, state);
      }
    }

    if (msg.type === "agent_renamed") {
      addActivity(ctx, state, `✏️ ${msg.oldName} → ${msg.newName}`);
      if (msg.id === state.agentId) {
        state.agentName = msg.newName;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`🐝 ${msg.oldName} renamed to ${msg.newName}`, "info");
        setNameplate(ctx, state);
      }
    }

    if (msg.type === "status_changed") {
      if (msg.status !== "busy") {
        state.notifiedStuck.delete(msg.id);
      } else if (msg.lastActivityAt) {
        const ts = Date.parse(msg.lastActivityAt);
        if (!Number.isNaN(ts) && Date.now() - ts <= STUCK_WINDOW_MS) {
          state.notifiedStuck.delete(msg.id);
        }
      }

      addActivity(ctx, state, `🔄 ${msg.name} → ${msg.status}`);
      if (ctx.hasUI) {
        updateNameplateWidget(ctx, state);
      }
    }

    if (msg.type === "channel_created") {
      addActivity(ctx, state, `🧵 #${msg.channel} created by ${msg.by}`);
      if (ctx.hasUI) {
        ctx.ui.notify(`🐝 #${msg.channel} created by ${msg.by}`, "info");
        updateNameplateWidget(ctx, state);
      }
    }

    if (msg.type === "channel_joined") {
      addActivity(ctx, state, `🧵 ${msg.agentName} joined #${msg.channel}`);
      if (ctx.hasUI) {
        updateNameplateWidget(ctx, state);
      }
    }

    if (msg.type === "channel_left") {
      addActivity(ctx, state, `🧵 ${msg.agentName} left #${msg.channel}`);
      if (ctx.hasUI) {
        updateNameplateWidget(ctx, state);
      }
    }
  });
}
