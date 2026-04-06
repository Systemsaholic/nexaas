/**
 * Chat Channel Adapter — delivers via Slack, Teams, WhatsApp, SMS, Telegram.
 *
 * Generic adapter that routes to the correct implementation based on
 * the channel's implementation.type and implementation.server.
 *
 * For now: logs the delivery intent. Full MCP integration in Sprint 3+.
 */

import { logger } from "@trigger.dev/sdk/v3";
import type { ChannelContract } from "../registry.js";

export interface ChatDeliveryPayload {
  channel: ChannelContract;
  message: string;
  metadata?: Record<string, unknown>;
  buttons?: Array<{ label: string; value: string }>;  // for interactive approvals
}

export async function deliverViaChat(payload: ChatDeliveryPayload): Promise<boolean> {
  const { channel, message } = payload;
  const impl = channel.implementation;

  logger.info(`Chat delivery via ${channel.channelId} (${impl.type}/${impl.server ?? "direct"})`);

  switch (impl.server) {
    case "mcp/slack":
      // TODO: Wire to Slack MCP server
      logger.info(`Slack: ${channel.displayName} — ${message.slice(0, 100)}`);
      break;

    case "mcp/telegram":
      // TODO: Wire to Telegram MCP server
      logger.info(`Telegram: ${channel.displayName} — ${message.slice(0, 100)}`);
      break;

    default:
      // Generic webhook or API
      if (impl.type === "webhook" && impl.config?.url) {
        try {
          await fetch(impl.config.url as string, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, metadata: payload.metadata, buttons: payload.buttons }),
          });
          return true;
        } catch (e) {
          logger.error(`Webhook delivery failed: ${(e as Error).message}`);
          return false;
        }
      }

      logger.warn(`No implementation for chat channel ${channel.channelId} (${impl.server})`);
      break;
  }

  return true;
}
