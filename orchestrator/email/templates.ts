/**
 * Email Template Engine — renders branded Nexmatic HTML emails with text fallback.
 *
 * Uses Handlebars (already a project dependency) with inline-styled HTML
 * for maximum email client compatibility.
 */

import Handlebars from "handlebars";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, "templates");

// Pre-compile base layout
const baseSource = readFileSync(join(TEMPLATE_DIR, "base.hbs"), "utf-8");
const baseTemplate = Handlebars.compile(baseSource);

// Pre-compile content partials
const partials: Record<string, HandlebarsTemplateDelegate> = {};

function getPartial(name: string): HandlebarsTemplateDelegate {
  if (!partials[name]) {
    const source = readFileSync(join(TEMPLATE_DIR, `${name}.hbs`), "utf-8");
    partials[name] = Handlebars.compile(source);
  }
  return partials[name];
}

/** Delivery types that map to template files */
export type EmailTemplateType =
  | "notification"
  | "alert"
  | "approval"
  | "escalation";

export interface EmailTemplateData {
  subject: string;
  summary: string;
  body?: string;
  details?: Record<string, string>;
  skillId?: string;
  workspaceName?: string;
  dashboardUrl?: string;
  actionUrl?: string;
  expiresIn?: string;
  severity?: string;
  buttons?: Array<{ label: string; value: string }>;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

/** Type label shown in the header */
const TYPE_LABELS: Record<EmailTemplateType, string> = {
  notification: "Notification",
  alert: "Alert",
  approval: "Action Required",
  escalation: "Escalation",
};

/** Accent bar config per type */
const ACCENT_CONFIG: Record<EmailTemplateType, { show: boolean; color: string }> = {
  notification: { show: false, color: "" },
  alert: { show: true, color: "#dc2626" },
  approval: { show: true, color: "#f59e0b" },
  escalation: { show: true, color: "#dc2626" },
};

export function renderEmailTemplate(
  type: EmailTemplateType,
  data: EmailTemplateData,
): RenderedEmail {
  // Escalation uses the alert template
  const templateName = type === "escalation" ? "alert" : type;
  const partial = getPartial(templateName);

  // Render the content partial
  const content = partial({
    ...data,
    severity: data.severity ?? (type === "escalation" ? "Critical" : "High"),
  });

  // Wrap in base layout
  const accent = ACCENT_CONFIG[type];
  const html = baseTemplate({
    subject: data.subject,
    typeLabel: TYPE_LABELS[type],
    content,
    accentBar: accent.show,
    accentColor: accent.color,
    workspaceName: data.workspaceName,
  });

  // Generate text fallback
  const text = htmlToText(content, data);

  return { html, text };
}

/**
 * Convert HTML content to plain text fallback.
 * Strips tags, preserves structure with newlines.
 */
function htmlToText(html: string, data: EmailTemplateData): string {
  const lines: string[] = [];

  lines.push(data.summary);
  lines.push("=".repeat(Math.min(data.summary.length, 60)));
  lines.push("");

  if (data.body) {
    lines.push(data.body);
    lines.push("");
  }

  if (data.details && Object.keys(data.details).length > 0) {
    for (const [key, value] of Object.entries(data.details)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push("");
  }

  if (data.dashboardUrl) {
    lines.push(`Review: ${data.dashboardUrl}`);
    lines.push("");
  }

  if (data.actionUrl) {
    lines.push(`View: ${data.actionUrl}`);
    lines.push("");
  }

  if (data.expiresIn) {
    lines.push(`Expires in: ${data.expiresIn}`);
    lines.push("");
  }

  if (data.skillId) {
    lines.push(`Skill: ${data.skillId}`);
  }

  lines.push("---");
  lines.push("Powered by Nexmatic — AI Business Automation");
  if (data.workspaceName) {
    lines.push(`Workspace: ${data.workspaceName}`);
  }

  return lines.join("\n");
}
