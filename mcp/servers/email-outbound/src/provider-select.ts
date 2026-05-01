/**
 * Provider selection — env-driven with optional workspace override.
 *
 * Order of resolution:
 *   1. `EMAIL_OUTBOUND_PROVIDER` env var — explicit operator pin
 *   2. `workspace_kv.email_outbound_provider` — runtime override per workspace
 *      (deferred to a follow-up: the MCP runs as its own process and doesn't
 *      have a palace session in scope; for now operators set the env var)
 *   3. First provider whose API key env is present — auto-detect
 *
 * Returns the provider instance, the provider name (for WAL / logs), and
 * the reason the provider was picked.
 */

import type { EmailProvider } from "./types.js";
import { ResendProvider } from "./providers/resend.js";

export interface SelectedProvider {
  provider: EmailProvider;
  name: string;
  reason: "env_pin" | "auto_detect";
}

export function selectProvider(): SelectedProvider {
  const explicitName = (process.env.EMAIL_OUTBOUND_PROVIDER ?? "").toLowerCase();
  const resendKey = process.env.RESEND_API_KEY;

  if (explicitName === "resend") {
    if (!resendKey) {
      throw new Error("EMAIL_OUTBOUND_PROVIDER=resend but RESEND_API_KEY is unset");
    }
    return { provider: new ResendProvider(resendKey), name: "resend", reason: "env_pin" };
  }

  if (explicitName) {
    throw new Error(
      `EMAIL_OUTBOUND_PROVIDER=${explicitName} not yet supported by this build. ` +
      `Available: resend. Postmark, SendGrid, AWS SES are tracked in #78 follow-up PR B.`,
    );
  }

  // Auto-detect — first key wins. Resend is the only implementation today;
  // additional providers will be probed in a stable order documented in the
  // server README so behavior is predictable when multiple keys are present.
  if (resendKey) {
    return { provider: new ResendProvider(resendKey), name: "resend", reason: "auto_detect" };
  }

  throw new Error(
    "No email-outbound provider configured. Set RESEND_API_KEY (or set EMAIL_OUTBOUND_PROVIDER " +
    "and the matching key) in the workspace .env. See #78.",
  );
}
