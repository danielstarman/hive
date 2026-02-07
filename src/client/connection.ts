/**
 * Hive WebSocket client.
 *
 * Connects to the broker, sends/receives protocol messages,
 * and maintains a local cache of known agents.
 */

import WebSocket from "ws";
import type { AgentInfo, ReservationMap } from "../types.js";
import type { ClientMessage, BrokerMessage } from "../broker/protocol.js";

export type MessageHandler = (msg: BrokerMessage) => void;

export class HiveClient {
  private ws: WebSocket | null = null;
  private listeners: MessageHandler[] = [];
  private knownAgents = new Map<string, AgentInfo>(); // id → info
  private reservations: ReservationMap = {};
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Connect to the broker. Resolves when the connection is open.
   */
  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      ws.on("open", () => {
        this.ws = ws;
        this.connected = true;

        // Heartbeat every 20s
        this.heartbeatTimer = setInterval(() => {
          this.send({ type: "heartbeat" });
        }, 20000);

        resolve();
      });

      ws.on("message", (raw) => {
        let msg: BrokerMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        this.handleBrokerMessage(msg);

        // Notify listeners (copy array to allow removal during iteration)
        for (const handler of [...this.listeners]) {
          handler(msg);
        }
      });

      ws.on("close", () => {
        this.connected = false;
        this.cleanup();
      });

      ws.on("error", (err) => {
        if (!this.connected) {
          reject(err);
        }
        // If already connected, just log — the close event will fire
      });
    });
  }

  /**
   * Register this agent with the broker.
   */
  register(opts: {
    id: string;
    name: string;
    role: string;
    parentId?: string;
    cwd: string;
    interactive: boolean;
  }): void {
    this.send({
      type: "register",
      ...opts,
    });
  }

  /**
   * Send a protocol message to the broker.
   */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Add a message listener. Returns the handler for removal.
   */
  onMessage(handler: MessageHandler): void {
    this.listeners.push(handler);
  }

  /**
   * Remove a message listener.
   */
  offMessage(handler: MessageHandler): void {
    const idx = this.listeners.indexOf(handler);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  /**
   * Get all known agents (cached from broker updates).
   */
  getKnownAgents(): AgentInfo[] {
    return Array.from(this.knownAgents.values());
  }

  /**
   * Get a specific agent by name.
   */
  getAgentByName(name: string): AgentInfo | undefined {
    for (const agent of this.knownAgents.values()) {
      if (agent.name === name) return agent;
    }
    return undefined;
  }

  /**
   * Current reservation map keyed by owner agent ID.
   */
  getReservations(): ReservationMap {
    const out: ReservationMap = {};
    for (const [agentId, reservation] of Object.entries(this.reservations)) {
      out[agentId] = {
        paths: [...reservation.paths],
        reason: reservation.reason,
      };
    }
    return out;
  }

  reserve(paths: string[], reason?: string): void {
    this.send({ type: "reserve", paths, reason });
  }

  release(paths?: string[]): void {
    if (paths && paths.length > 0) {
      this.send({ type: "release", paths });
      return;
    }
    this.send({ type: "release" });
  }

  sendPresence(statusMessage?: string): void {
    this.send({
      type: "presence_update",
      statusMessage,
      lastActivityAt: new Date().toISOString(),
    });
  }

  /**
   * Whether the client is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the connection.
   */
  close(): void {
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private handleBrokerMessage(msg: BrokerMessage): void {
    switch (msg.type) {
      case "registered":
        // Full agent list + reservations on registration
        this.knownAgents.clear();
        for (const agent of msg.agents) {
          this.knownAgents.set(agent.id, agent);
        }
        this.reservations = {};
        for (const [agentId, reservation] of Object.entries(msg.reservations || {})) {
          this.reservations[agentId] = {
            paths: [...reservation.paths],
            reason: reservation.reason,
          };
        }
        break;

      case "agent_joined":
        this.knownAgents.set(msg.agent.id, msg.agent);
        break;

      case "agent_left":
        this.knownAgents.delete(msg.id);
        break;

      case "agent_renamed": {
        const agent = this.knownAgents.get(msg.id);
        if (agent) {
          agent.name = msg.newName;
        }
        break;
      }

      case "agent_list":
        this.knownAgents.clear();
        for (const agent of msg.agents) {
          this.knownAgents.set(agent.id, agent);
        }
        break;

      case "reservations_updated": {
        this.reservations = {};
        for (const [agentId, reservation] of Object.entries(msg.reservations || {})) {
          this.reservations[agentId] = {
            paths: [...reservation.paths],
            reason: reservation.reason,
          };
        }
        break;
      }

      case "status_changed": {
        const agent = this.knownAgents.get(msg.id);
        if (agent) {
          agent.status = msg.status;
          if ("statusMessage" in msg) {
            agent.statusMessage = msg.statusMessage || undefined;
          }
          if ("lastActivityAt" in msg) {
            agent.lastActivityAt = msg.lastActivityAt;
          }
        }
        break;
      }

      case "channel_created": {
        const creator = this.getAgentByName(msg.by);
        if (creator && !creator.channels.includes(msg.channel)) {
          creator.channels.push(msg.channel);
        }
        break;
      }

      case "channel_joined": {
        const agent = this.knownAgents.get(msg.agentId);
        if (agent && !agent.channels.includes(msg.channel)) {
          agent.channels.push(msg.channel);
        }
        break;
      }

      case "channel_left": {
        const agent = this.knownAgents.get(msg.agentId);
        if (agent) {
          agent.channels = agent.channels.filter((c) => c !== msg.channel);
        }
        break;
      }
    }
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
