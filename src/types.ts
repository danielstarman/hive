/**
 * Shared types for the Hive agent network.
 */

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  parentId?: string;
  cwd: string;
  status: "idle" | "busy" | "done";
  channels: string[];
  interactive: boolean;
  statusMessage?: string;
  lastActivityAt?: string;
}

export interface BrokerConfig {
  port: number;
  pid: number;
  hubId: string;
  startedAt: number;
}

export interface ChannelInfo {
  name: string;
  members: string[];
  createdBy: string;
}

export interface ReservationInfo {
  paths: string[];
  reason?: string;
}

export type ReservationMap = Record<string, ReservationInfo>;
