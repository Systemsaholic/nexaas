/**
 * Nexaas Notifications — unified alert dispatch for the framework.
 *
 * Channels: Telegram, Email (Resend), Palace (always-on).
 * Supports severity-based routing, rate limiting, and ack/snooze.
 */

import { sql, appendWal } from "@nexaas/palace";

export type NotificationSeverity = "critical" | "warning" | "info";
export type NotificationChannel = "telegram" | "email" | "palace";

export interface NotificationPayload {
  workspace: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  component?: string;
  skillId?: string;
  channels?: NotificationChannel[];
  dedupeKey?: string;
  dedupeWindowMinutes?: number;
}

interface NotificationConfig {
  telegram?: { botToken: string; chatId: string };
  email?: { apiKey: string; from: string; to: string[] };
}

function getConfig(): NotificationConfig {
  const config: NotificationConfig = {};

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID) {
    config.telegram = {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_ALERT_CHAT_ID,
    };
  }

  if (process.env.RESEND_API_KEY && process.env.OPS_ALERT_EMAIL) {
    config.email = {
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.OPS_ALERT_FROM ?? "Nexaas Alerts <alerts@nexmatic.ca>",
      to: process.env.OPS_ALERT_EMAIL.split(",").map(e => e.trim()),
    };
  }

  return config;
}

const recentNotifications = new Map<string, number>();

function isDuplicate(key: string, windowMinutes: number): boolean {
  const lastSent = recentNotifications.get(key);
  if (!lastSent) return false;
  return Date.now() - lastSent < windowMinutes * 60_000;
}

export async function notify(payload: NotificationPayload): Promise<{ sent: NotificationChannel[] }> {
  const config = getConfig();
  const sent: NotificationChannel[] = [];

  if (payload.dedupeKey) {
    const window = payload.dedupeWindowMinutes ?? 15;
    if (isDuplicate(payload.dedupeKey, window)) {
      return { sent: [] };
    }
    recentNotifications.set(payload.dedupeKey, Date.now());
  }

  const channels = payload.channels ?? resolveChannels(payload.severity, config);

  // Palace — always record
  try {
    await sql(
      `INSERT INTO nexaas_memory.events
        (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id)
       VALUES ($1, 'notifications', 'alerts', $2, $3, encode(digest($3, 'sha256'), 'hex'), 'alert', 'notifications', $4)`,
      [
        payload.workspace,
        payload.severity,
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          severity: payload.severity,
          component: payload.component,
          timestamp: new Date().toISOString(),
        }),
        payload.skillId ?? "system",
      ],
    );
    sent.push("palace");
  } catch { /* palace write failure shouldn't block notifications */ }

  // Telegram
  if (channels.includes("telegram") && config.telegram) {
    try {
      const icon = payload.severity === "critical" ? "🔴" : payload.severity === "warning" ? "🟡" : "🔵";
      const text = `${icon} *${payload.title}*\n\n${payload.body}\n\n_${payload.workspace} — ${new Date().toLocaleString("en-US", { timeZone: "America/Toronto" })}_`;

      const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegram.chatId, text, parse_mode: "Markdown" }),
      });
      if (res.ok) sent.push("telegram");
    } catch { /* silent */ }
  }

  // Email via Resend
  if (channels.includes("email") && config.email) {
    try {
      const icon = payload.severity === "critical" ? "[CRITICAL]" : payload.severity === "warning" ? "[WARNING]" : "[INFO]";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.email.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.email.from,
          to: config.email.to,
          subject: `${icon} ${payload.title} — ${payload.workspace}`,
          text: `${payload.title}\n\n${payload.body}\n\nWorkspace: ${payload.workspace}\nComponent: ${payload.component ?? "system"}\nTime: ${new Date().toISOString()}`,
          html: `<h2>${escapeHtml(payload.title)}</h2><p>${escapeHtml(payload.body).replace(/\n/g, "<br>")}</p><hr><p style="color:#666;font-size:12px">Workspace: ${escapeHtml(payload.workspace)} | Component: ${escapeHtml(payload.component ?? "system")} | ${new Date().toISOString()}</p>`,
        }),
      });
      if (res.ok) sent.push("email");
    } catch { /* silent */ }
  }

  // WAL
  try {
    await appendWal({
      workspace: payload.workspace,
      op: "notification_sent",
      actor: "system:notifications",
      payload: {
        title: payload.title,
        severity: payload.severity,
        channels_sent: sent,
        component: payload.component,
      },
    });
  } catch { /* WAL failure shouldn't block */ }

  return { sent };
}

function resolveChannels(severity: NotificationSeverity, config: NotificationConfig): NotificationChannel[] {
  const channels: NotificationChannel[] = ["palace"];

  if (severity === "critical") {
    if (config.telegram) channels.push("telegram");
    if (config.email) channels.push("email");
  } else if (severity === "warning") {
    if (config.telegram) channels.push("telegram");
  }

  return channels;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function getRecentAlerts(workspace: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<Record<string, unknown>>(
    `SELECT content, created_at::text
     FROM nexaas_memory.events
     WHERE workspace = $1 AND wing = 'notifications' AND hall = 'alerts'
     ORDER BY created_at DESC LIMIT $2`,
    [workspace, limit],
  );
  return rows.map(r => ({ ...JSON.parse(r.content as string), created_at: r.created_at }));
}

export async function snoozeAlert(workspace: string, component: string, durationMinutes: number): Promise<void> {
  const key = `snooze:${workspace}:${component}`;
  recentNotifications.set(key, Date.now());

  await appendWal({
    workspace,
    op: "alert_snoozed",
    actor: "ops",
    payload: { component, duration_minutes: durationMinutes, until: new Date(Date.now() + durationMinutes * 60_000).toISOString() },
  });
}
