/**
 * Hive WebSocket broker server.
 *
 * Manages agent registration, message routing (DMs, broadcasts, channels),
 * and heartbeat monitoring. Runs in-process on the hub.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { AgentInfo, ChannelInfo, ReservationInfo, ReservationMap } from "../types.js";
import type { ClientMessage, BrokerMessage } from "./protocol.js";

interface ConnectedAgent {
  info: AgentInfo;
  ws: WebSocket;
  lastHeartbeat: number;
}

interface Channel {
  name: string;
  members: Set<string>; // agent IDs
  createdBy: string;
}

function normalizeReservationPath(raw: string): string {
  let p = (raw || "").trim();
  if (!p) return "";

  const isDir = /[\\/]$/.test(p);
  p = p.replace(/\\/g, "/").replace(/\/+/g, "/");

  if (isDir) {
    p = p.replace(/\/+$/, "") + "/";
  } else {
    p = p.replace(/\/+$/, "");
  }

  if (!p) return isDir ? "/" : "";
  return p;
}

function reservationPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;

  const aDir = a.endsWith("/");
  const bDir = b.endsWith("/");

  if (aDir && (b.startsWith(a) || b === a.slice(0, -1))) return true;
  if (bDir && (a.startsWith(b) || a === b.slice(0, -1))) return true;

  return false;
}

function dedupePaths(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export class HiveBroker {
  private wss: WebSocketServer | null = null;
  private agents = new Map<string, ConnectedAgent>(); // id → agent
  private nameToId = new Map<string, string>(); // name → id
  private channels = new Map<string, Channel>();
  private reservations = new Map<string, ReservationInfo>(); // agent id -> reserved paths
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  port = 0;

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });

      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        this.port =
          typeof addr === "object" && addr ? addr.port : 0;

        // Heartbeat check every 30s
        this.heartbeatInterval = setInterval(
          () => this.checkHeartbeats(),
          30000
        );

        resolve(this.port);
      });

      this.wss.on("error", (err) => {
        reject(err);
      });

      this.wss.on("connection", (ws) => {
        let agentId: string | null = null;

        ws.on("message", (raw) => {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            this.sendTo(ws, {
              type: "error",
              message: "Invalid JSON",
            });
            return;
          }

          if (msg.type === "register") {
            agentId = msg.id;
            this.handleRegister(ws, msg);
          } else if (agentId) {
            this.handleMessage(agentId, msg);
          } else {
            this.sendTo(ws, {
              type: "error",
              message: "Must register first",
            });
          }
        });

        ws.on("close", () => {
          if (agentId) {
            this.handleDisconnect(agentId);
          }
        });

        ws.on("error", () => {
          if (agentId) {
            this.handleDisconnect(agentId);
          }
        });
      });
    });
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all connections
    for (const agent of this.agents.values()) {
      try {
        agent.ws.close();
      } catch {
        /* ignore */
      }
    }

    this.agents.clear();
    this.nameToId.clear();
    this.channels.clear();
    this.reservations.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map((a) => a.info);
  }

  getChannels(): ChannelInfo[] {
    return Array.from(this.channels.values()).map((ch) => ({
      name: ch.name,
      members: Array.from(ch.members),
      createdBy: ch.createdBy,
    }));
  }

  getReservations(): ReservationMap {
    const out: ReservationMap = {};
    for (const [agentId, res] of this.reservations.entries()) {
      out[agentId] = {
        paths: [...res.paths],
        reason: res.reason,
      };
    }
    return out;
  }

  disconnectAgentByName(name: string): boolean {
    const id = this.nameToId.get(name);
    if (!id) return false;
    return this.disconnectAgentById(id);
  }

  disconnectAgentById(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    try {
      agent.ws.close();
    } catch {
      /* ignore */
    }

    // close() may trigger the websocket close handler asynchronously;
    // force immediate cleanup for command-driven disconnects.
    this.handleDisconnect(id);
    return true;
  }

  // ── Registration ────────────────────────────────────────────────────

  private handleRegister(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "register" }>
  ): void {
    // Ensure unique name
    let name = msg.name;
    if (this.nameToId.has(name)) {
      let i = 2;
      while (this.nameToId.has(`${name}-${i}`)) i++;
      name = `${name}-${i}`;
    }

    const info: AgentInfo = {
      id: msg.id,
      name,
      role: msg.role,
      parentId: msg.parentId,
      cwd: msg.cwd,
      status: "idle",
      channels: [],
      interactive: msg.interactive,
      lastActivityAt: new Date().toISOString(),
    };

    const agent: ConnectedAgent = {
      info,
      ws,
      lastHeartbeat: Date.now(),
    };

    this.agents.set(msg.id, agent);
    this.nameToId.set(name, msg.id);

    // Confirm registration with current agent list
    this.sendTo(ws, {
      type: "registered",
      id: msg.id,
      agents: this.getAgents(),
      reservations: this.getReservations(),
    });

    // Notify others
    this.broadcastExcept(msg.id, {
      type: "agent_joined",
      agent: info,
    });
  }

  private handleDisconnect(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const name = agent.info.name;
    const hadReservations = this.reservations.delete(agentId);

    // Remove from channels
    for (const ch of this.channels.values()) {
      ch.members.delete(agentId);
    }

    // Clean up empty channels
    for (const [chName, ch] of this.channels.entries()) {
      if (ch.members.size === 0) {
        this.channels.delete(chName);
      }
    }

    this.agents.delete(agentId);
    this.nameToId.delete(name);

    // Notify others
    this.broadcastExcept(agentId, {
      type: "agent_left",
      id: agentId,
      name,
    });

    if (hadReservations) {
      this.broadcastReservationsUpdated();
    }
  }

  // ── Message Routing ─────────────────────────────────────────────────

  private handleMessage(senderId: string, msg: ClientMessage): void {
    const sender = this.agents.get(senderId);
    if (!sender) return;

    switch (msg.type) {
      case "dm":
        this.handleDm(sender, msg);
        break;
      case "dm_response":
        this.handleDmResponse(sender, msg);
        break;
      case "broadcast":
        this.handleBroadcast(sender, msg);
        break;
      case "channel_create":
        this.handleChannelCreate(sender, msg);
        break;
      case "channel_join":
        this.handleChannelJoin(sender, msg);
        break;
      case "channel_leave":
        this.handleChannelLeave(sender, msg);
        break;
      case "channel_send":
        this.handleChannelSend(sender, msg);
        break;
      case "list_agents":
        this.sendTo(sender.ws, {
          type: "agent_list",
          agents: this.getAgents(),
        });
        break;
      case "list_channels":
        this.sendTo(sender.ws, {
          type: "channel_list",
          channels: this.getChannels(),
        });
        break;
      case "reserve":
        this.handleReserve(sender, msg);
        break;
      case "release":
        this.handleRelease(sender, msg);
        break;
      case "rename":
        this.handleRename(sender, msg);
        break;
      case "presence_update":
        this.handlePresenceUpdate(sender, msg);
        break;
      case "status_update":
        this.handleStatusUpdate(sender, msg);
        break;
      case "heartbeat":
        sender.lastHeartbeat = Date.now();
        this.sendTo(sender.ws, { type: "heartbeat_ack" });
        break;
    }
  }

  private handleDm(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "dm" }>
  ): void {
    const targetId = this.nameToId.get(msg.to);
    if (!targetId) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Agent "${msg.to}" is not online`,
        correlationId: msg.correlationId,
      });
      return;
    }

    const target = this.agents.get(targetId);
    if (!target) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Agent "${msg.to}" is not online`,
        correlationId: msg.correlationId,
      });
      return;
    }

    this.sendTo(target.ws, {
      type: "dm",
      from: sender.info.id,
      fromName: sender.info.name,
      content: msg.content,
      correlationId: msg.correlationId,
    });
  }

  private handleDmResponse(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "dm_response" }>
  ): void {
    const targetId = this.nameToId.get(msg.to);
    if (!targetId) return;

    const target = this.agents.get(targetId);
    if (!target) return;

    this.sendTo(target.ws, {
      type: "dm_response",
      from: sender.info.id,
      fromName: sender.info.name,
      correlationId: msg.correlationId,
      content: msg.content,
    });
  }

  private handleBroadcast(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "broadcast" }>
  ): void {
    this.broadcastExcept(sender.info.id, {
      type: "broadcast",
      from: sender.info.id,
      fromName: sender.info.name,
      content: msg.content,
    });
  }

  private handleChannelCreate(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "channel_create" }>
  ): void {
    if (this.channels.has(msg.channel)) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Channel "${msg.channel}" already exists`,
      });
      return;
    }

    const channel: Channel = {
      name: msg.channel,
      members: new Set([sender.info.id]),
      createdBy: sender.info.name,
    };
    this.channels.set(msg.channel, channel);

    sender.info.channels.push(msg.channel);

    // Notify all agents
    this.broadcastAll({
      type: "channel_created",
      channel: msg.channel,
      by: sender.info.name,
    });
  }

  private handleChannelJoin(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "channel_join" }>
  ): void {
    const channel = this.channels.get(msg.channel);
    if (!channel) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Channel "${msg.channel}" does not exist`,
      });
      return;
    }

    channel.members.add(sender.info.id);
    if (!sender.info.channels.includes(msg.channel)) {
      sender.info.channels.push(msg.channel);
    }

    // Notify channel members
    for (const memberId of channel.members) {
      const member = this.agents.get(memberId);
      if (member) {
        this.sendTo(member.ws, {
          type: "channel_joined",
          channel: msg.channel,
          agentId: sender.info.id,
          agentName: sender.info.name,
        });
      }
    }
  }

  private handleChannelLeave(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "channel_leave" }>
  ): void {
    const channel = this.channels.get(msg.channel);
    if (!channel) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Channel "${msg.channel}" does not exist`,
      });
      return;
    }

    if (!channel.members.has(sender.info.id)) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `You are not a member of channel "${msg.channel}"`,
      });
      return;
    }

    channel.members.delete(sender.info.id);
    sender.info.channels = sender.info.channels.filter(
      (c) => c !== msg.channel
    );

    // Notify sender + remaining members
    this.sendTo(sender.ws, {
      type: "channel_left",
      channel: msg.channel,
      agentId: sender.info.id,
      agentName: sender.info.name,
    });

    for (const memberId of channel.members) {
      const member = this.agents.get(memberId);
      if (member) {
        this.sendTo(member.ws, {
          type: "channel_left",
          channel: msg.channel,
          agentId: sender.info.id,
          agentName: sender.info.name,
        });
      }
    }

    // Clean up empty channels
    if (channel.members.size === 0) {
      this.channels.delete(msg.channel);
    }
  }

  private handleChannelSend(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "channel_send" }>
  ): void {
    const channel = this.channels.get(msg.channel);
    if (!channel) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Channel "${msg.channel}" does not exist`,
      });
      return;
    }

    if (!channel.members.has(sender.info.id)) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `You are not a member of channel "${msg.channel}"`,
      });
      return;
    }

    // Send to all members except sender
    for (const memberId of channel.members) {
      if (memberId === sender.info.id) continue;
      const member = this.agents.get(memberId);
      if (member) {
        this.sendTo(member.ws, {
          type: "channel_message",
          channel: msg.channel,
          from: sender.info.id,
          fromName: sender.info.name,
          content: msg.content,
        });
      }
    }

    // Ack to sender so tools can report delivery success.
    this.sendTo(sender.ws, {
      type: "channel_sent",
      channel: msg.channel,
    });
  }

  private handleReserve(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "reserve" }>
  ): void {
    const normalized = dedupePaths(
      (msg.paths || [])
        .map((p) => normalizeReservationPath(p))
        .filter((p) => !!p)
    );

    if (normalized.length === 0) {
      this.sendTo(sender.ws, {
        type: "error",
        message: "No valid paths to reserve",
      });
      return;
    }

    // Check for conflicts with other agents.
    for (const targetPath of normalized) {
      for (const [ownerId, reservation] of this.reservations.entries()) {
        if (ownerId === sender.info.id) continue;

        for (const reservedPath of reservation.paths) {
          if (reservationPathsOverlap(targetPath, reservedPath)) {
            const ownerName = this.agents.get(ownerId)?.info.name || ownerId;
            const reasonText = reservation.reason ? `: ${reservation.reason}` : "";
            this.sendTo(sender.ws, {
              type: "error",
              message: `File reserved by ${ownerName}${reasonText}`,
            });
            return;
          }
        }
      }
    }

    const existing = this.reservations.get(sender.info.id);
    const merged = dedupePaths([...(existing?.paths || []), ...normalized]);

    this.reservations.set(sender.info.id, {
      paths: merged,
      reason: msg.reason ?? existing?.reason,
    });

    this.broadcastReservationsUpdated();
  }

  private handleRelease(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "release" }>
  ): void {
    const existing = this.reservations.get(sender.info.id);

    if (!existing) {
      this.broadcastReservationsUpdated();
      return;
    }

    if (!msg.paths || msg.paths.length === 0) {
      this.reservations.delete(sender.info.id);
      this.broadcastReservationsUpdated();
      return;
    }

    const toRelease = new Set(
      msg.paths.map((p) => normalizeReservationPath(p)).filter((p) => !!p)
    );

    const remaining = existing.paths.filter((p) => !toRelease.has(p));

    if (remaining.length === 0) {
      this.reservations.delete(sender.info.id);
    } else {
      this.reservations.set(sender.info.id, {
        paths: remaining,
        reason: existing.reason,
      });
    }

    this.broadcastReservationsUpdated();
  }

  private handleRename(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "rename" }>
  ): void {
    const newName = msg.name.trim();
    const oldName = sender.info.name;

    if (!newName) {
      this.sendTo(sender.ws, {
        type: "error",
        message: "Name cannot be empty",
      });
      return;
    }

    const ownerId = this.nameToId.get(newName);
    if (ownerId && ownerId !== sender.info.id) {
      this.sendTo(sender.ws, {
        type: "error",
        message: `Agent name "${newName}" is already taken`,
      });
      return;
    }

    // No-op rename still returns a rename event so callers can treat
    // this as success without special-casing.
    if (oldName !== newName) {
      this.nameToId.delete(oldName);
      this.nameToId.set(newName, sender.info.id);
      sender.info.name = newName;

      // Keep channel metadata in sync.
      for (const ch of this.channels.values()) {
        if (ch.createdBy === oldName) {
          ch.createdBy = newName;
        }
      }
    }

    this.broadcastAll({
      type: "agent_renamed",
      id: sender.info.id,
      oldName,
      newName,
    });
  }

  private handlePresenceUpdate(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "presence_update" }>
  ): void {
    sender.info.statusMessage = msg.statusMessage || undefined;
    sender.info.lastActivityAt = msg.lastActivityAt;

    this.broadcastExcept(sender.info.id, {
      type: "status_changed",
      id: sender.info.id,
      name: sender.info.name,
      status: sender.info.status,
      statusMessage: msg.statusMessage,
      lastActivityAt: sender.info.lastActivityAt,
    });
  }

  private handleStatusUpdate(
    sender: ConnectedAgent,
    msg: Extract<ClientMessage, { type: "status_update" }>
  ): void {
    sender.info.status = msg.status;
    this.broadcastExcept(sender.info.id, {
      type: "status_changed",
      id: sender.info.id,
      name: sender.info.name,
      status: msg.status,
      statusMessage: sender.info.statusMessage,
      lastActivityAt: sender.info.lastActivityAt,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private sendTo(ws: WebSocket, msg: BrokerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastAll(msg: BrokerMessage): void {
    for (const agent of this.agents.values()) {
      this.sendTo(agent.ws, msg);
    }
  }

  private broadcastExcept(excludeId: string, msg: BrokerMessage): void {
    for (const [id, agent] of this.agents.entries()) {
      if (id !== excludeId) {
        this.sendTo(agent.ws, msg);
      }
    }
  }

  private broadcastReservationsUpdated(): void {
    this.broadcastAll({
      type: "reservations_updated",
      reservations: this.getReservations(),
    });
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    const timeout = 60000; // 60s

    for (const [id, agent] of this.agents.entries()) {
      if (now - agent.lastHeartbeat > timeout) {
        try {
          agent.ws.close();
        } catch {
          /* ignore */
        }
        this.handleDisconnect(id);
      }
    }
  }
}
