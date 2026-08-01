/**
 * #269 — schedule-aware stale-skill classification (recovered Phoenix
 * hotfix 5072c96, generalized). Pure tests: fixture manifests under a tmp
 * NEXAAS_WORKSPACE_ROOT, injectable `now`, no DB (workspaceTimezone falls
 * back to NEXAAS_TIMEZONE/UTC when the pool is unreachable; fixtures pin
 * their own timezone anyway so verdicts are deterministic).
 *
 * Fixed dates: 2026-07-24 = Friday, 07-25 = Saturday, 07-27 = Monday.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyStaleSkill } from "../packages/runtime/src/tasks/health-monitor.js";
import { invalidateSkillManifestIndex } from "../packages/runtime/src/skill-manifest-index.js";

const tmp = mkdtempSync(join(tmpdir(), "nexaas-269-"));
const WS = "vitest-269";
let prevRoot: string | undefined;
let prevTz: string | undefined;

function writeSkill(id: string, yaml: string) {
  const dir = join(tmp, "nexaas-skills", ...id.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.yaml"), yaml);
}

beforeAll(() => {
  prevRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  prevTz = process.env.NEXAAS_TIMEZONE;
  process.env.NEXAAS_WORKSPACE_ROOT = tmp;
  process.env.NEXAAS_TIMEZONE = "UTC";

  writeSkill("ops/business-hours", [
    "id: ops/business-hours",
    "version: '1'",
    "timezone: UTC",
    "triggers:",
    "  - type: cron",
    "    schedule: '*/30 8-19 * * 1-5'",
    "execution: { type: shell, command: 'true' }",
  ].join("\n"));

  writeSkill("ops/event-driven", [
    "id: ops/event-driven",
    "version: '1'",
    "triggers:",
    "  - type: inbound-message",
    "    channel_role: some_channel",
    "execution: { type: ai-skill }",
  ].join("\n"));

  invalidateSkillManifestIndex();
});

afterAll(() => {
  process.env.NEXAAS_WORKSPACE_ROOT = prevRoot;
  process.env.NEXAAS_TIMEZONE = prevTz;
  invalidateSkillManifestIndex();
  rmSync(tmp, { recursive: true, force: true });
});

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

describe("classifyStaleSkill (#269)", () => {
  it("skips retired skills (no manifest on disk)", async () => {
    const v = await classifyStaleSkill(WS, "ops/deleted-long-ago", 999);
    expect(v.kind).toBe("retired");
  });

  it("exempts event-driven skills — idle is not stale", async () => {
    const v = await classifyStaleSkill(WS, "ops/event-driven", 10_000);
    expect(v.kind).toBe("event-driven");
  });

  it("business-hours cron silent over the weekend: zero missed fires", async () => {
    const lastRun = new Date("2026-07-24T19:30:00Z"); // Friday 19:30 — last scheduled fire (8-19 includes 19:30)
    const now = new Date("2026-07-25T03:00:00Z");     // Saturday 03:00
    const v = await classifyStaleSkill(WS, "ops/business-hours", minutesBetween(lastRun, now), now);
    expect(v).toEqual({ kind: "cron", missed: 0, schedules: ["*/30 8-19 * * 1-5"] });
  });

  it("same skill genuinely stale Monday mid-morning: ≥3 missed fires", async () => {
    const lastRun = new Date("2026-07-24T19:00:00Z"); // Friday 19:00
    const now = new Date("2026-07-27T10:05:00Z");     // Monday 10:05 — missed 8:00/8:30/9:00…
    const v = await classifyStaleSkill(WS, "ops/business-hours", minutesBetween(lastRun, now), now);
    expect(v.kind).toBe("cron");
    expect((v as { missed: number }).missed).toBeGreaterThanOrEqual(3);
  });
});
