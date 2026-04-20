/**
 * Workspace Manifest schema (architecture.md §16).
 *
 * The canonical shape for a workspace's declarative configuration.
 * Owned by the framework; every consuming business (Nexmatic and
 * future licensees) supplies manifests matching this schema.
 *
 * Tenant-specific extensions (plan, addons, billing fields, Nexmatic's
 * subdomain config) are allowed via `.passthrough()` — the framework
 * ignores them, the consuming business is responsible for validating
 * its own fields.
 *
 * Versioning: `manifest_version` is the schema version the manifest
 * conforms to. Validator supports reading older versions with
 * defaulting; emits a WAL warning when upgrading is recommended.
 */

import { z } from "zod";

/** Current framework-canonical manifest version. */
export const CURRENT_MANIFEST_VERSION = "0.2";

/** Channel kinds known to the framework. Additional kinds allowed. */
export const ChannelKind = z.string(); // open-ended — telegram | slack | whatsapp | email | sms | ...

/** Capability stages per capabilities/_registry.yaml. */
export const CapabilityStage = z.enum(["experimental", "converging", "stable"]);

/**
 * capability_bindings — capability name → concrete MCP + config.
 * Matches architecture.md §16: "capability → MCP mapping".
 */
export const CapabilityBinding = z.object({
  mcp: z.string().min(1, "mcp required"),
  config: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

/**
 * channel_bindings — role → channel kind + MCP + config.
 * Matches architecture.md §13: "Skills reference channels by role, not kind".
 * The framework never uses the kind for dispatch — adapters do.
 */
export const ChannelBinding = z.object({
  kind: ChannelKind,
  mcp: z.string().min(1, "mcp required"),
  config: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

/**
 * installed_agents — active agent bundles. Each bundle is identified by id
 * and may carry per-workspace config overrides (voice tweaks, model tier).
 */
export const InstalledAgent = z.object({
  id: z.string().min(1),
  version: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

/**
 * behavioral_contract — architecture.md §14 two-layer policy envelope.
 * Tone + approval posture + skill-specific overrides.
 */
export const BehavioralContract = z.object({
  tone: z.string().default(""),
  approval_posture: z.enum(["conservative", "standard", "permissive"]).default("standard"),
  skill_overrides: z.array(z.object({
    skill_id: z.string(),
    overrides: z.record(z.string(), z.unknown()),
  })).default([]),
  schema_extensions: z.array(z.object({
    skill_id: z.string(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().default(false),
    })),
  })).default([]),
}).passthrough();

/**
 * model_policy — workspace-level tier routing defaults + skill overrides.
 * Skill-level `model_tier` still wins; this sets the workspace default.
 */
export const ModelPolicy = z.object({
  default_tier: z.enum(["cheap", "good", "better", "best"]).default("good"),
  overrides: z.array(z.object({
    skill_pattern: z.string(),
    tier: z.enum(["cheap", "good", "better", "best"]),
  })).default([]),
}).passthrough();

/**
 * custom_domains — client-owned domains routed to this workspace VPS.
 * Self-service per architecture.md §17 (network topology).
 */
export const CustomDomain = z.object({
  domain: z.string(),
  primary: z.boolean().default(false),
  verified_at: z.string().optional(), // ISO timestamp
}).passthrough();

/**
 * Full workspace manifest.
 *
 * Framework validates only the fields listed here. Extra top-level fields
 * (plan, addons, subdomain, trigger, etc. from Nexmatic's layer) pass
 * through untouched — the framework is tenant-agnostic by contract.
 */
export const WorkspaceManifest = z.object({
  manifest_version: z.string().default("0.1"),
  id: z.string().min(1),
  name: z.string().default(""),
  workspace_root: z.string().optional(),

  capability_bindings: z.record(z.string(), CapabilityBinding).default({}),
  channel_bindings: z.record(z.string(), ChannelBinding).default({}),
  installed_agents: z.array(InstalledAgent).default([]),
  behavioral_contract: BehavioralContract.default({
    tone: "",
    approval_posture: "standard",
    skill_overrides: [],
    schema_extensions: [],
  }),
  model_policy: ModelPolicy.default({
    default_tier: "good",
    overrides: [],
  }),
  custom_domains: z.array(CustomDomain).default([]),
}).passthrough();

export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;
export type CapabilityBinding = z.infer<typeof CapabilityBinding>;
export type ChannelBinding = z.infer<typeof ChannelBinding>;
export type BehavioralContract = z.infer<typeof BehavioralContract>;
export type ModelPolicy = z.infer<typeof ModelPolicy>;

/**
 * Validation result — warnings are non-fatal, errors indicate the manifest
 * couldn't be parsed at all. Framework startup must never halt on warnings;
 * existing deployments (BSBC, Fairway, pre-v0.2 Phoenix) need time to
 * migrate without a forced outage.
 */
export interface ValidationResult {
  ok: boolean;
  manifest?: WorkspaceManifest;
  warnings: string[];
  errors: string[];
}

/**
 * Validate a raw workspace-manifest object against the schema.
 * Returns warnings for version mismatches and deprecated fields, errors
 * for unrecoverable parse failures (missing id, wrong types on required
 * fields). The caller decides what's fatal.
 */
export function validateManifest(raw: unknown): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const parsed = WorkspaceManifest.safeParse(raw);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return { ok: false, warnings, errors };
  }

  const manifest = parsed.data;

  if (manifest.manifest_version !== CURRENT_MANIFEST_VERSION) {
    warnings.push(
      `manifest_version is "${manifest.manifest_version}"; current is "${CURRENT_MANIFEST_VERSION}". ` +
      `Non-fatal — framework continues with compatibility defaults.`,
    );
  }

  // Spec-level sanity warnings that don't block startup.
  if (Object.keys(manifest.channel_bindings).length === 0
      && Object.keys(manifest.capability_bindings).length === 0
      && manifest.installed_agents.length === 0) {
    warnings.push(
      "manifest declares no capability_bindings, channel_bindings, or installed_agents — " +
      "nothing in this workspace can use capability/channel primitives. Probably not intended.",
    );
  }

  // Channel-binding sanity: every role's MCP should be referenced in
  // capability_bindings if it's a messaging MCP. We can't enforce this
  // hard without coupling to the capability stage graph, so it's a
  // gentle heads-up rather than an error.
  for (const [role, binding] of Object.entries(manifest.channel_bindings)) {
    if (!binding.mcp) {
      errors.push(`channel_bindings.${role}.mcp is required`);
    }
  }

  return {
    ok: errors.length === 0,
    manifest: errors.length === 0 ? manifest : undefined,
    warnings,
    errors,
  };
}
