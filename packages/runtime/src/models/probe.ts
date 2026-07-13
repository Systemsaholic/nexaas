/**
 * Cheapest registry model for 1-token API-key/credit probes (#255).
 *
 * status/health/health-monitor previously hardcoded a haiku model id —
 * when that id ages out, every health probe starts failing with
 * model_not_found and reads as an API outage. The registry is the single
 * source of truth; the static fallback exists only so a probe can still
 * run (and report) when the registry file itself is unreadable.
 */
import { resolveTier } from "./registry.js";

export function probeModel(): string {
  try {
    return resolveTier("cheap").primary.model;
  } catch {
    return "claude-haiku-4-5-20251001";
  }
}
