/**
 * Channel Registry — CRUD for channel registrations.
 *
 * Architecture Guide v4 §6
 *
 * Each instance has its own channel registry in Postgres.
 * Skills declare channel REQUIREMENTS. The resolver finds the right channel.
 */

import { query, queryOne, queryAll } from "../db.js";

export interface ChannelContract {
  channelId: string;
  displayName: string;
  direction: "one-way" | "two-way";
  criticality: "mission-critical" | "standard" | "fyi";
  latency: "realtime" | "near-realtime" | "async";
  implementation: {
    type: "mcp" | "api" | "internal" | "webhook";
    server?: string;
    credentialRef?: string;
    config?: Record<string, unknown>;
  };
  capabilities: string[];
  formatConstraints?: Record<string, unknown>;
  fallbackChannel?: string;
  healthCheck: boolean;
}

export async function listChannels(workspaceId: string): Promise<ChannelContract[]> {
  const rows = await queryAll(
    `SELECT * FROM channel_registry WHERE workspace_id = $1 AND active = true ORDER BY display_name`,
    [workspaceId]
  );
  return rows.map(mapRow);
}

export async function getChannel(workspaceId: string, channelId: string): Promise<ChannelContract | null> {
  const row = await queryOne(
    `SELECT * FROM channel_registry WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId]
  );
  return row ? mapRow(row) : null;
}

export async function registerChannel(workspaceId: string, channel: ChannelContract): Promise<void> {
  await query(
    `INSERT INTO channel_registry
     (workspace_id, channel_id, display_name, direction, criticality, latency,
      implementation, capabilities, format_constraints, fallback_channel, health_check, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
     ON CONFLICT (workspace_id, channel_id) DO UPDATE SET
       display_name = $3, direction = $4, criticality = $5, latency = $6,
       implementation = $7, capabilities = $8, format_constraints = $9,
       fallback_channel = $10, health_check = $11`,
    [
      workspaceId,
      channel.channelId,
      channel.displayName,
      channel.direction,
      channel.criticality,
      channel.latency,
      JSON.stringify(channel.implementation),
      channel.capabilities,
      JSON.stringify(channel.formatConstraints ?? {}),
      channel.fallbackChannel ?? null,
      channel.healthCheck,
    ]
  );
}

export async function deactivateChannel(workspaceId: string, channelId: string): Promise<void> {
  await query(
    `UPDATE channel_registry SET active = false WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId]
  );
}

function mapRow(row: any): ChannelContract {
  return {
    channelId: row.channel_id,
    displayName: row.display_name,
    direction: row.direction,
    criticality: row.criticality,
    latency: row.latency,
    implementation: typeof row.implementation === "string" ? JSON.parse(row.implementation) : row.implementation,
    capabilities: row.capabilities ?? [],
    formatConstraints: typeof row.format_constraints === "string" ? JSON.parse(row.format_constraints) : row.format_constraints,
    fallbackChannel: row.fallback_channel,
    healthCheck: row.health_check,
  };
}
