/**
 * @nexaas/integration-sdk — public surface (#88).
 *
 * Imports from this module are the *only* supported entry point for
 * integration authors. Capability-specific shapes (e.g., `EmailProvider`)
 * land here as separate sub-modules in subsequent phases as each
 * capability gains its first reference integration.
 */

export {
  CapabilityImplementationSchema,
  IntegrationManifestSchema,
} from "./manifest.js";
export type {
  CapabilityImplementation,
  IntegrationManifest,
} from "./manifest.js";

export { withTimeout, asArray } from "./helpers.js";
