/**
 * WebSocket protocol message types for Hive broker communication.
 *
 * Client → Broker: The broker knows the sender via the WebSocket connection.
 * Broker → Client: Includes sender identity (id + name) for routing context.
 */

import type { AgentInfo, ChannelInfo, ReservationMap } from "../types.js";

// ── Client → Broker ─────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      type: "register";
      id: string;
      name: string;
      role: string;
      parentId?: string;
      cwd: string;
      interactive: boolean;
    }
  | { type: "dm"; to: string; content: string; correlationId?: string }
  | { type: "dm_response"; to: string; correlationId: string; content: string }
  | { type: "broadcast"; content: string }
  | { type: "channel_create"; channel: string }
  | { type: "channel_join"; channel: string }
  | { type: "channel_leave"; channel: string }
  | { type: "channel_send"; channel: string; content: string }
  | { type: "list_agents" }
  | { type: "list_channels" }
  | { type: "reserve"; paths: string[]; reason?: string }
  | { type: "release"; paths?: string[] }
  | { type: "rename"; name: string }
  | { type: "presence_update"; statusMessage?: string; lastActivityAt: string }
  | { type: "status_update"; status: AgentInfo["status"] }
  | { type: "heartbeat" };

// ── Broker → Client ─────────────────────────────────────────────────────────

export type BrokerMessage =
  | { type: "registered"; id: string; agents: AgentInfo[]; reservations: ReservationMap }
  | { type: "agent_joined"; agent: AgentInfo }
  | { type: "agent_left"; id: string; name: string }
  | { type: "agent_renamed"; id: string; oldName: string; newName: string }
  | {
      type: "dm";
      from: string;
      fromName: string;
      content: string;
      correlationId?: string;
    }
  | {
      type: "dm_response";
      from: string;
      fromName: string;
      correlationId: string;
      content: string;
    }
  | { type: "broadcast"; from: string; fromName: string; content: string }
  | { type: "channel_created"; channel: string; by: string }
  | {
      type: "channel_joined";
      channel: string;
      agentId: string;
      agentName: string;
    }
  | {
      type: "channel_left";
      channel: string;
      agentId: string;
      agentName: string;
    }
  | {
      type: "channel_message";
      channel: string;
      from: string;
      fromName: string;
      content: string;
    }
  | { type: "channel_sent"; channel: string }
  | { type: "agent_list"; agents: AgentInfo[] }
  | { type: "channel_list"; channels: ChannelInfo[] }
  | { type: "reservations_updated"; reservations: ReservationMap }
  | {
      type: "status_changed";
      id: string;
      name: string;
      status: AgentInfo["status"];
      statusMessage?: string;
      lastActivityAt?: string;
    }
  | { type: "error"; message: string; correlationId?: string }
  | { type: "heartbeat_ack" };
