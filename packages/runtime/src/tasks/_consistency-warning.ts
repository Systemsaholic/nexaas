/**
 * Shared helper for surfacing schema-drift errors loudly-once.
 *
 * Background — #72: a migration was recorded in `schema_migrations` without
 * its SQL having actually run, so the inbound-dispatcher silently exception-
 * logged for ~7 days while every poll cycle threw "relation
 * inbound_dispatches does not exist". The dispatcher caught the error,
 * `console.error`'d it, and slept. No WAL signal, no operator-visible
 * indication that anything was wrong — the only symptom was that 2FA
 * waitpoints mysteriously timed out.
 *
 * This helper:
 *   - Detects the Postgres "relation does not exist" code (42P01).
 *   - Emits a `framework_consistency_warning` WAL op exactly once per
 *     (source, relation) pair per process lifetime so silent failure
 *     becomes observable without flooding WAL on every poll tick.
 *   - Returns `true` when the error was a schema-drift error (caller
 *     should suppress the generic console.error to avoid double-logging).
 *
 * The dedup Set resets on worker restart — warnings re-fire on the next
 * deploy if the underlying drift hasn't been repaired. Operators looking
 * for stuck dispatchers can grep WAL for `framework_consistency_warning`
 * (or wire it into the silent-failure watchdog from #69 via
 * `NEXAAS_SILENT_FAILURE_CHANNEL_ROLE`).
 */

import { appendWal } from "@nexaas/palace";

const PG_UNDEFINED_TABLE = "42P01";

const _warnedMissingRelations = new Set<string>();

export async function reportMissingRelation(
  workspace: string,
  source: string,
  err: unknown,
): Promise<boolean> {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e || e.code !== PG_UNDEFINED_TABLE) return false;
  const message = e.message ?? "";
  const m = message.match(/relation "([^"]+)" does not exist/);
  const relation = m?.[1] ?? "<unknown>";
  const key = `${source}:${relation}`;
  if (_warnedMissingRelations.has(key)) return true;
  _warnedMissingRelations.add(key);
  console.error(
    `[nexaas] ${source}: relation ${relation} does not exist — schema drift, ` +
    `likely a recorded-but-not-applied migration (see #72). ` +
    `Re-run \`nexaas upgrade --migrate\` to repair.`,
  );
  await appendWal({
    workspace,
    op: "framework_consistency_warning",
    actor: source,
    payload: {
      kind: "missing_relation",
      relation,
      pg_error_code: PG_UNDEFINED_TABLE,
      remediation: "nexaas upgrade --migrate",
    },
  }).catch(() => { /* WAL itself might be missing — best effort */ });
  return true;
}
