/**
 * Integration manifest schema (#88).
 *
 * Every integration package ships a `nexaas-integration.yaml` next to
 * its `package.json` declaring which capability it implements, the
 * capability-version range it satisfies, and the env vars it needs.
 *
 * The framework loads this at integration discovery time (manifest-driven
 * `integrations:` array in the workspace manifest) and validates against
 * the capability registry before registering the provider.
 */

import { z } from "zod";

/**
 * One capability implementation declared by an integration. An integration
 * package MAY implement multiple capabilities (e.g., a future
 * `@nexaas/email-resend` could implement both `email-outbound` and
 * `email-stats`) — hence the array shape on `implements`.
 */
export const CapabilityImplementationSchema = z.object({
  /** Capability identifier from `capabilities/_registry.yaml`. */
  capability: z.string().min(1),
  /**
   * Semver range the integration claims compatibility with. Framework
   * checks the live capability version against this at load time and
   * rejects mismatches loudly rather than letting an integration written
   * against v0.2 silently run on v1.x.
   */
  version: z.string().min(1),
  /**
   * Human/operator-facing provider name surfaced in WAL entries, logs,
   * and tool responses. e.g., `resend`, `postmark`, `aws_ses`. Stable;
   * changing it is a breaking change for any skill that pins to it.
   */
  provider_name: z.string().min(1),
});

export type CapabilityImplementation = z.infer<typeof CapabilityImplementationSchema>;

/**
 * Top-level integration manifest. Read by the framework's integration
 * loader; not consumed directly by skills.
 */
export const IntegrationManifestSchema = z.object({
  /** Package-style identifier — should match the npm package name. */
  name: z.string().min(1),
  implements: z.array(CapabilityImplementationSchema).min(1),
  env: z
    .object({
      required: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
    })
    .default({ required: [], optional: [] }),
  /**
   * Path to the JS entry that exports the integration factory. Resolved
   * relative to the package root. The exported factory must conform to
   * the relevant capability's interface (e.g., `EmailProvider` for
   * email-outbound implementations).
   */
  entry: z.string().min(1),
});

export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
