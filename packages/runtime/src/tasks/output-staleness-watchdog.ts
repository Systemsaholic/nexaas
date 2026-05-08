/**
 * Output-cadence staleness watchdog (#86 Gap 1).
 *
 * Catches the failure mode where a skill runs to status='completed' but
 * its declared `outputs[]` never land downstream (no broadcast scheduled,
 * no email sent, no asset uploaded). The cron fires, Claude returns,
 * skill_runs records `completed` — and from the framework's perspective
 * everything is green. Phoenix's marketing canary sat in this state for
 * 14 days (social) / 6 days (email) before a human noticed.
 *
 * The framework already knows what outputs exist (manifest.outputs[]) and
 * already records when each one is produced (the `output_produced` WAL
 * op emitted by ai-skill-framework-tools). This watchdog is the missing
 * loop: per (skill_id, output_id) declared with `staleness_alert`, check
 * whether `MAX(created_at) WHERE op='output_produced' AND ...` is older
 * than `max_silence`. If so, alert.
 *
 * Manifest schema:
 *
 *   outputs:
 *     - id: broadcast_scheduled
 *       routing_default: auto_execute
 *       staleness_alert:
 *         max_silence: 9d                # 9d, 12h, 30m — duration string
 *         channel_role: ops_escalations  # binds to workspace manifest
 *
 * Skills without `staleness_alert` are silently ignored — the field is
 * additive and adopters opt-in per output.
 *
 * De-dupe: idempotency_key encodes the last-produced timestamp (or
 * 'never'), so once an alert fires it doesn't repeat until the output
 * either produces something new (changing the key) or stays silent for
 * another full max_silence window.
 *
 * Configuration:
 *   NEXAAS_OUTPUT_STALENESS_INTERVAL_MS  default 6h; minimum 60s
 *   NEXAAS_OUTPUT_STALENESS_DEFAULT_ROLE optional fallback channel_role
 *                                        for outputs that declared
 *                                        staleness_alert.max_silence
 *                                        without channel_role
 *
 * The watchdog reads skill manifests from
 * $NEXAAS_WORKSPACE_ROOT/nexaas-skills on each tick — same path the worker
 * already uses for cron self-heal. Manifests are small and parsed once
 * per tick (default 6h), so the cost is sub-second on Phoenix's 138-skill
 * tree.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { load as yamlLoad } from "js-yaml";
import { sql, palace, appendWal } from "@nexaas/palace";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_ROLE = process.env.NEXAAS_OUTPUT_STALENESS_DEFAULT_ROLE;

let _interval: NodeJS.Timeout | null = null;
let _polling = false;

interface StalenessConfig {
  max_silence: string;
  channel_role?: string;
}

interface OutputDecl {
  id: string;
  staleness_alert?: StalenessConfig;
}

interface ManifestForStaleness {
  id: string;
  outputs?: OutputDecl[];
}

export interface StaleOutput {
  skillId: string;
  outputId: string;
  maxSilenceMs: number;
  silentForMs: number;
  lastProducedIso: string | null;
  channelRole: string;
}

/**
 * Parse a duration string like "9d", "12h", "30m". Returns 0 for
 * unparseable input — caller treats 0 as "skip this output, don't alert
 * on garbage manifest".
 */
export function parseDuration(s: string): number {
  if (typeof s !== "string") return 0;
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (m[2]) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    case "d":  return n * 24 * 60 * 60 * 1000;
    default:   return 0;
  }
}

function loadManifest(path: string): ManifestForStaleness | null {
  try {
    const m = yamlLoad(readFileSync(path, "utf-8")) as ManifestForStaleness;
    if (!m?.id || !Array.isArray(m.outputs)) return null;
    return m;
  } catch { return null; }
}

function findManifests(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];
  for (const category of readdirSync(skillsRoot)) {
    const catPath = join(skillsRoot, category);
    let catStat;
    try { catStat = statSync(catPath); } catch { continue; }
    if (!catStat.isDirectory()) continue;
    for (const skillName of readdirSync(catPath)) {
      const skillPath = join(catPath, skillName, "skill.yaml");
      if (existsSync(skillPath)) out.push(skillPath);
    }
  }
  return out;
}

/**
 * Find outputs whose `MAX(output_produced.created_at)` is older than the
 * declared max_silence. Exported for the regression test; not part of
 * the runtime's public surface.
 */
export async function findStaleOutputs(
  workspace: string,
  manifestPaths: string[],
  now: number = Date.now(),
): Promise<StaleOutput[]> {
  const stale: StaleOutput[] = [];
  for (const path of manifestPaths) {
    const manifest = loadManifest(path);
    if (!manifest) continue;
    for (const output of manifest.outputs ?? []) {
      const cfg = output.staleness_alert;
      if (!cfg?.max_silence) continue;
      const channelRole = cfg.channel_role ?? DEFAULT_ROLE;
      if (!channelRole) continue;

      const maxSilenceMs = parseDuration(cfg.max_silence);
      if (maxSilenceMs === 0) continue;

      const rows = await sql<{ last_at: string | null }>(
        `SELECT MAX(created_at)::text AS last_at
           FROM nexaas_memory.wal
          WHERE workspace = $1
            AND op = 'output_produced'
            AND payload->>'skill_id' = $2
            AND payload->>'output_id' = $3`,
        [workspace, manifest.id, output.id],
      );

      const lastAtIso = rows[0]?.last_at ?? null;
      const lastAtMs = lastAtIso ? Date.parse(lastAtIso) : null;
      const silentForMs = lastAtMs === null ? Number.POSITIVE_INFINITY : now - lastAtMs;

      if (silentForMs > maxSilenceMs) {
        stale.push({
          skillId: manifest.id,
          outputId: output.id,
          maxSilenceMs,
          silentForMs: Number.isFinite(silentForMs) ? silentForMs : maxSilenceMs * 2,
          lastProducedIso: lastAtIso,
          channelRole,
        });
      }
    }
  }
  return stale;
}

async function emitStaleAlerts(
  workspace: string,
  stale: StaleOutput[],
): Promise<number> {
  if (stale.length === 0) return 0;
  const session = palace.enter({ workspace });
  let emitted = 0;
  for (const s of stale) {
    const lastTok = s.lastProducedIso ?? "never";
    const silentMin = Math.round(s.silentForMs / 60000);
    const maxMin = Math.round(s.maxSilenceMs / 60000);
    try {
      await session.writeDrawer(
        { wing: "notifications", hall: "pending", room: "ops-alerts.output-stale" },
        JSON.stringify({
          idempotency_key: `output-stale:${workspace}:${s.skillId}:${s.outputId}:${lastTok}`,
          channel_role: s.channelRole,
          content:
            `⚠️ Output silent: ${s.skillId} → ${s.outputId}\n` +
            `Last produced: ${s.lastProducedIso ?? "never"}\n` +
            `Silent for: ${silentMin} min (max ${maxMin} min)`,
        }),
      );
      emitted++;
    } catch (err) {
      console.error(
        `[nexaas] output-staleness: emit failed for ${s.skillId}/${s.outputId}:`,
        err,
      );
    }
  }
  return emitted;
}

export async function checkOutputStaleness(
  workspace: string,
  skillsRoot: string,
): Promise<{ stale: number; alerted: number }> {
  const manifests = findManifests(skillsRoot);
  const stale = await findStaleOutputs(workspace, manifests);
  if (stale.length === 0) return { stale: 0, alerted: 0 };

  const alerted = await emitStaleAlerts(workspace, stale);
  await appendWal({
    workspace,
    op: "output_staleness_detected",
    actor: "output-staleness-watchdog",
    payload: {
      stale_count: stale.length,
      alerted_count: alerted,
      sample: stale.slice(0, 5).map((s) => ({
        skill_id: s.skillId,
        output_id: s.outputId,
        silent_min: Math.round(s.silentForMs / 60000),
        max_silence_min: Math.round(s.maxSilenceMs / 60000),
      })),
    },
  });
  return { stale: stale.length, alerted };
}

export function startOutputStalenessWatchdog(
  workspace: string,
  skillsRoot: string,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;

  const raw = opts.intervalMs ?? Number.parseInt(
    process.env.NEXAAS_OUTPUT_STALENESS_INTERVAL_MS ?? `${DEFAULT_INTERVAL_MS}`,
    10,
  );
  const interval = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? raw : DEFAULT_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      const result = await checkOutputStaleness(workspace, skillsRoot);
      if (result.stale > 0) {
        console.log(
          `[nexaas] Output staleness watchdog: ${result.stale} stale output(s), ${result.alerted} alert(s) emitted`,
        );
      }
    } catch (err) {
      console.error("[nexaas] output-staleness-watchdog tick error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(
    `[nexaas] Output staleness watchdog started (every ${Math.round(interval / 60000)} min, scanning ${skillsRoot})`,
  );
}

export function stopOutputStalenessWatchdog(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
