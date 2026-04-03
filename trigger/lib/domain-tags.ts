/**
 * Domain tags for Trigger.dev task runs.
 *
 * Every task run is tagged with its business domain so the TD dashboard
 * can filter by domain (e.g., "domain:accounting", "domain:marketing").
 *
 * Usage in task definitions:
 *   import { domainTag } from "../lib/domain-tags.js";
 *   tags: domainTag("accounting")
 *
 * Usage in trigger() / triggerAndWait():
 *   await myTask.trigger(payload, { tags: domainTag("marketing") });
 */

/** Canonical business domains */
export type Domain =
  | "accounting"
  | "crm"
  | "hr"
  | "marketing"
  | "operations"
  | "pa"
  | "seo"
  | "social"
  | "data-sync";

/** Returns a tags array with the domain tag */
export function domainTag(domain: Domain): string[] {
  return [`domain:${domain}`];
}

/**
 * Resolve domain from agent name using a workspace domain map.
 * The map is loaded from workspace manifest's `domainMap` field.
 * Falls back to "operations" if no match.
 */
export function domainForAgent(
  agent: string,
  domainMap?: Record<string, Domain>
): Domain {
  if (!domainMap) return "operations";
  // Exact match first
  if (domainMap[agent]) return domainMap[agent];
  // Prefix match
  const prefix = Object.keys(domainMap).find((k) => agent.startsWith(k));
  return prefix ? domainMap[prefix] : "operations";
}
