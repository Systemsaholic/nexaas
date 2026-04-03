/**
 * Two-pass contamination scanner for feedback signals.
 *
 * Pass 1: Regex scan for PII, credentials, client names, paths, domains.
 * Pass 2: Claude Haiku semantic scan (only on ambiguous Pass 1 results).
 *
 * Runs on client VPSes before feedback is stored.
 */

import { runClaude } from "../../trigger/lib/claude.js";

export interface Violation {
  type: "pii" | "credential" | "client_name" | "path" | "domain";
  match: string;
  position: number;
}

export interface SanitizationResult {
  status: "clean" | "flagged";
  originalText: string;
  cleanedText?: string;
  violations: Violation[];
  pass1Result: "clean" | "flagged" | "ambiguous";
  pass2Result?: "clean" | "flagged";
  reviewerSummary?: string;
}

// ── Pass 1: Regex patterns ──────────────────────────────────────────────────

const PATTERNS: Array<{ type: Violation["type"]; regex: RegExp }> = [
  // Credentials
  { type: "credential", regex: /sk-[a-zA-Z0-9]{20,}/g },
  { type: "credential", regex: /ghp_[a-zA-Z0-9]{36,}/g },
  { type: "credential", regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi },
  { type: "credential", regex: /token[=:]\s*[a-zA-Z0-9._\-]{20,}/gi },
  { type: "credential", regex: /api[_-]?key[=:]\s*[a-zA-Z0-9._\-]{16,}/gi },
  // PII
  { type: "pii", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
  { type: "pii", regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g },
  { type: "pii", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Absolute paths (Linux)
  { type: "path", regex: /\/home\/[a-zA-Z0-9_-]+\/[^\s"']+/g },
  { type: "path", regex: /\/opt\/workspaces\/[^\s"']+/g },
];

function pass1Scan(text: string, clientNames: string[]): {
  result: "clean" | "flagged" | "ambiguous";
  violations: Violation[];
} {
  const violations: Violation[] = [];

  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      violations.push({ type, match: match[0], position: match.index });
    }
  }

  for (const name of clientNames) {
    if (name.length < 3) continue;
    const nameRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
    let match;
    while ((match = nameRegex.exec(text)) !== null) {
      violations.push({ type: "client_name", match: match[0], position: match.index });
    }
  }

  for (const name of clientNames) {
    const slug = name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
    if (slug.length < 4) continue;
    const domainRegex = new RegExp(`\\b${escapeRegex(slug)}\\.[a-z]{2,}\\b`, "gi");
    let match;
    while ((match = domainRegex.exec(text)) !== null) {
      violations.push({ type: "domain", match: match[0], position: match.index });
    }
  }

  if (violations.length === 0) return { result: "clean", violations };
  const highConfidence = violations.some(
    (v) => v.type === "credential" || v.type === "pii"
  );
  return {
    result: highConfidence ? "flagged" : "ambiguous",
    violations,
  };
}

// ── Pass 2: Claude Haiku semantic scan ──────────────────────────────────────

async function pass2Scan(text: string): Promise<{
  result: "clean" | "flagged";
  summary: string;
}> {
  const result = await runClaude({
    prompt: `Analyze this text for client-specific information that should NOT be in a shared skill improvement proposal. Look for: company names, employee names, specific project details, internal URLs, or any data that identifies a specific business.

Text to analyze:
---
${text.slice(0, 1500)}
---

Respond with exactly one line:
CLEAN: [reason] — if the text is generic and safe to share across workspaces
FLAGGED: [reason] — if the text contains client-specific information

Respond with CLEAN or FLAGGED only.`,
    model: "haiku",
    timeoutMs: 30_000,
    mcpServers: [],
  });

  if (!result.success) {
    return { result: "flagged", summary: `Haiku scan failed: ${result.error}` };
  }

  const isFlagged = result.output.toUpperCase().startsWith("FLAGGED");
  return {
    result: isFlagged ? "flagged" : "clean",
    summary: result.output.slice(0, 500),
  };
}

// ── Main sanitize function ──────────────────────────────────────────────────

export async function sanitize(
  text: string,
  clientNames: string[]
): Promise<SanitizationResult> {
  const { result: p1Result, violations } = pass1Scan(text, clientNames);

  if (p1Result === "clean") {
    return {
      status: "clean",
      originalText: text,
      violations: [],
      pass1Result: "clean",
    };
  }

  if (p1Result === "flagged") {
    return {
      status: "flagged",
      originalText: text,
      cleanedText: redactViolations(text, violations),
      violations,
      pass1Result: "flagged",
    };
  }

  const { result: p2Result, summary } = await pass2Scan(text);
  return {
    status: p2Result === "clean" ? "clean" : "flagged",
    originalText: text,
    cleanedText: p2Result === "flagged" ? redactViolations(text, violations) : undefined,
    violations,
    pass1Result: "ambiguous",
    pass2Result: p2Result,
    reviewerSummary: summary,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function redactViolations(text: string, violations: Violation[]): string {
  let result = text;
  const sorted = [...violations].sort((a, b) => b.position - a.position);
  for (const v of sorted) {
    result =
      result.slice(0, v.position) +
      `[REDACTED:${v.type}]` +
      result.slice(v.position + v.match.length);
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
