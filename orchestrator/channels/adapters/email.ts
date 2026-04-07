/**
 * Email Channel Adapter — delivers via Resend (transactional @nexmatic.ca emails).
 *
 * Handles: notifications, alerts, approvals, escalations.
 * Uses branded HTML templates with plain text fallback.
 *
 * NOT for client email automation (that's the Email MCP — separate adapter).
 */

import { logger } from "@trigger.dev/sdk/v3";
import { sendEmail, FROM } from "../../email/resend.js";
import { renderEmailTemplate, type EmailTemplateType } from "../../email/templates.js";

export interface EmailDeliveryPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  /** Delivery type — determines template and from address */
  type?: "notification" | "alert" | "approval" | "escalation";
  /** Structured details rendered as key-value table */
  details?: Record<string, unknown>;
  /** Action buttons (rendered as dashboard links in approval emails) */
  buttons?: Array<{ label: string; value: string }>;
  /** Workspace ID for footer branding */
  workspaceId?: string;
  /** Skill ID for reference */
  skillId?: string;
  /** Dashboard URL for approval/alert actions */
  dashboardUrl?: string;
}

export async function deliverViaEmail(payload: EmailDeliveryPayload): Promise<boolean> {
  const templateType: EmailTemplateType = payload.type ?? "notification";

  // Determine from address based on urgency
  const fromAddress = payload.from
    ?? (templateType === "alert" || templateType === "escalation" ? FROM.alert : FROM.noreply);

  // Flatten details to string values for template rendering
  const details = payload.details
    ? Object.fromEntries(
        Object.entries(payload.details)
          .filter(([_, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])
      )
    : undefined;

  // Build dashboard URL for approvals
  const dashboardUrl = payload.dashboardUrl
    ?? (payload.workspaceId ? `https://${payload.workspaceId}.nexmatic.ca/approvals` : undefined);

  // Render branded HTML + text fallback
  const { html, text } = renderEmailTemplate(templateType, {
    subject: payload.subject,
    summary: payload.subject,
    body: payload.body,
    details,
    skillId: payload.skillId,
    workspaceName: payload.workspaceId,
    dashboardUrl: templateType === "approval" ? dashboardUrl : undefined,
    actionUrl: templateType === "alert" || templateType === "escalation" ? dashboardUrl : undefined,
    expiresIn: templateType === "approval" ? "7 days" : undefined,
  });

  // Send via Resend
  const result = await sendEmail({
    to: payload.to,
    subject: payload.subject,
    html,
    text,
    from: fromAddress,
    replyTo: payload.replyTo,
    cc: payload.cc,
  });

  if (!result.success) {
    logger.error(`Email delivery failed: to=${payload.to} error=${result.error}`);
  }

  return result.success;
}
