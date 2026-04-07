/**
 * Channel Delivery — unified entry point for all channel output.
 *
 * Routes to the correct adapter based on channel implementation type.
 * Handles fallback on failure.
 */

import { logger } from "@trigger.dev/sdk/v3";
import type { ChannelContract } from "./registry.js";
import { getChannel } from "./registry.js";
import { deliverViaDashboard } from "./adapters/dashboard.js";
import { deliverViaEmail } from "./adapters/email.js";
import { deliverViaChat } from "./adapters/chat.js";

export interface DeliveryPayload {
  workspaceId: string;
  skillId?: string;
  channel: ChannelContract;
  type: "approval" | "notification" | "alert" | "escalation";
  summary: string;
  body: string;
  details?: Record<string, unknown>;
  waitTokenId?: string;
  targetEmail?: string;
  buttons?: Array<{ label: string; value: string }>;
}

export async function deliver(payload: DeliveryPayload): Promise<boolean> {
  const { channel, workspaceId } = payload;

  logger.info(`Delivering ${payload.type} via ${channel.channelId} (${channel.implementation.type})`);

  let success = false;

  switch (channel.implementation.type) {
    case "internal":
      // Dashboard / Nexmatic portal
      success = await deliverViaDashboard({
        workspaceId,
        skillId: payload.skillId,
        type: payload.type === "escalation" ? "alert" : payload.type === "notification" ? "notification" : "approval",
        summary: payload.summary,
        details: payload.details ?? {},
        waitTokenId: payload.waitTokenId,
      });
      break;

    case "mcp":
    case "api":
      // Email or chat depending on the server
      if (
        channel.implementation.server?.includes("email") ||
        channel.implementation.server?.includes("smtp") ||
        channel.implementation.server?.includes("resend")
      ) {
        const emailTo = payload.targetEmail
          ?? (channel.implementation.config?.to as string | undefined)
          ?? "";
        success = await deliverViaEmail({
          to: emailTo,
          subject: payload.summary,
          body: payload.body,
          type: payload.type,
          details: payload.details,
          buttons: payload.buttons,
          workspaceId: payload.workspaceId,
          skillId: payload.skillId,
        });
      } else {
        success = await deliverViaChat({
          channel,
          message: `**${payload.summary}**\n\n${payload.body}`,
          metadata: payload.details,
          buttons: payload.buttons,
        });
      }
      break;

    case "webhook":
      success = await deliverViaChat({
        channel,
        message: payload.body,
        metadata: { ...payload.details, type: payload.type },
      });
      break;

    default:
      logger.warn(`Unknown channel type: ${channel.implementation.type}`);
      break;
  }

  // Fallback on failure
  if (!success && channel.fallbackChannel) {
    logger.warn(`Primary channel ${channel.channelId} failed, trying fallback: ${channel.fallbackChannel}`);
    const fallback = await getChannel(workspaceId, channel.fallbackChannel);
    if (fallback) {
      return deliver({ ...payload, channel: fallback });
    }
  }

  return success;
}
