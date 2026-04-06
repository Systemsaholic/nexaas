/**
 * Channel Resolver — requirement-based channel resolution.
 *
 * Architecture Guide v4 §6.5
 *
 * Skills declare channel REQUIREMENTS (direction, criticality, capabilities).
 * The resolver finds the best matching channel for this instance + user.
 *
 * Resolution order:
 * 1. Filter by direction + criticality + capabilities
 * 2. Prefer user's channel preference
 * 3. Then department default
 * 4. Then instance default
 * 5. Fallback if nothing matches
 */

import { listChannels, type ChannelContract } from "./registry.js";
import { query, queryOne } from "../db.js";
import { logger } from "@trigger.dev/sdk/v3";

export interface ChannelRequirement {
  direction: "one-way" | "two-way";
  criticality?: "mission-critical" | "standard" | "fyi";
  capabilities?: string[];
  latency?: "realtime" | "near-realtime" | "async";
}

export interface ResolvedChannel {
  channel: ChannelContract;
  resolvedVia: "user-preference" | "department-default" | "instance-default" | "fallback";
}

export async function resolveChannel(
  workspaceId: string,
  requirement: ChannelRequirement,
  context: {
    targetRole?: string;
    targetEmail?: string;
    department?: string;
    preferenceType?: string;  // approval, briefing, urgent, digest
  }
): Promise<ResolvedChannel | null> {
  const allChannels = await listChannels(workspaceId);

  // Step 1: Filter by hard requirements
  let candidates = allChannels.filter((ch) => {
    // Direction must match
    if (requirement.direction === "two-way" && ch.direction !== "two-way") return false;

    // Criticality: mission-critical channels can serve any request
    if (requirement.criticality === "mission-critical" && ch.criticality === "fyi") return false;

    // Capabilities: all required capabilities must be present
    if (requirement.capabilities) {
      for (const cap of requirement.capabilities) {
        if (!ch.capabilities.includes(cap)) return false;
      }
    }

    // Latency: realtime can only use realtime channels
    if (requirement.latency === "realtime" && ch.latency !== "realtime") return false;

    return true;
  });

  if (candidates.length === 0) {
    logger.warn(`No channels match requirement: ${JSON.stringify(requirement)}`);

    // Try fallback: find any two-way channel
    const fallback = allChannels.find((ch) => ch.direction === "two-way");
    if (fallback) {
      return { channel: fallback, resolvedVia: "fallback" };
    }

    // Last resort: dashboard channel (always exists after deploy)
    const dashboard = allChannels.find((ch) => ch.channelId === "dashboard");
    if (dashboard) {
      return { channel: dashboard, resolvedVia: "fallback" };
    }

    return null;
  }

  // Step 2: Check user preference
  if (context.targetEmail && context.preferenceType) {
    const pref = await queryOne<{ channel_id: string }>(
      `SELECT channel_id FROM user_channel_preferences
       WHERE workspace_id = $1 AND user_email = $2 AND preference_type = $3`,
      [workspaceId, context.targetEmail, context.preferenceType]
    );

    if (pref) {
      const preferred = candidates.find((ch) => ch.channelId === pref.channel_id);
      if (preferred) {
        return { channel: preferred, resolvedVia: "user-preference" };
      }
    }
  }

  // Step 3: Pick highest criticality match
  const sorted = candidates.sort((a, b) => {
    const critOrder = { "mission-critical": 0, standard: 1, fyi: 2 };
    return (critOrder[a.criticality] ?? 1) - (critOrder[b.criticality] ?? 1);
  });

  return { channel: sorted[0], resolvedVia: "instance-default" };
}

// Resolve all channels a skill needs at task start
export async function resolveSkillChannels(
  workspaceId: string,
  channelRequirements: Record<string, ChannelRequirement>,
  context: { targetEmail?: string; department?: string }
): Promise<Record<string, ResolvedChannel | null>> {
  const resolved: Record<string, ResolvedChannel | null> = {};

  for (const [name, req] of Object.entries(channelRequirements)) {
    resolved[name] = await resolveChannel(workspaceId, req, {
      ...context,
      preferenceType: name,
    });
  }

  return resolved;
}
