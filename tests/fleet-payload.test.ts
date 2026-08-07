/**
 * #216 — fleet heartbeat payload v3 vs the published receiver contract.
 * DB-gated (collectors hit palace + BullMQ). Two guards:
 *   1. A real buildPayloadV3() output validates against a zod schema
 *      transcribed from docs/fleet-heartbeat-contract.md.
 *   2. Doc drift: every top-level payload field is named in the contract
 *      doc (the #258 one-directional pattern — code may not grow
 *      undocumented fields).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPayloadV3, getFrameworkIdentity } from "../packages/runtime/src/fleet/heartbeat.js";
import { getPool, sql, writeDrawerRaw } from "../packages/palace/src/index.js";

const hasDb = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;
const WS = `vitest-216-${process.pid}`;

const beatSchema = z.object({
  payload_version: z.literal(3),
  workspace: z.string(),
  version: z.string(),
  commit_sha: z.string().nullable(),
  branch: z.string().nullable(),
  describe: z.string().nullable(),
  channel: z.string().nullable(),
  hostname: z.string(),
  started_at: z.string(),
  now: z.string(),
  worker_status: z.literal("running"),
  uptime_s: z.number(),
  runs_24h: z.object({
    completed: z.number(), failed: z.number(), skipped: z.number(),
    success_rate_pct: z.number().nullable(),
  }).nullable(),
  spend: z.object({
    day: z.string(), spent_usd: z.number(),
    budget_usd: z.number().nullable(), paused: z.boolean(),
  }).nullable(),
  migrations: z.object({ applied: z.number(), pending: z.number() }).nullable(),
  conformance: z.record(z.unknown()).nullable(),
  queue: z.object({
    waiting: z.number(), active: z.number(), delayed: z.number(),
    failed: z.number(), paused: z.boolean(),
  }).nullable(),
  health: z.object({
    status: z.string(), alerts: z.number(),
    alert_components: z.array(z.string()), checked_at: z.string(),
  }).nullable(),
}).strict();

afterAll(async () => {
  if (!hasDb) return;
  await sql(`DELETE FROM nexaas_memory.events WHERE workspace = $1`, [WS]);
  await getPool().end().catch(() => {});
});

describe.skipIf(!hasDb)("fleet heartbeat payload v3 (#216)", () => {
  it("a real beat validates against the contract schema (health populated)", async () => {
    // Seed a health-monitor report so the health collector has a drawer.
    await writeDrawerRaw(
      WS, { wing: "ops", hall: "health", room: "monitor" },
      JSON.stringify({
        status: "degraded",
        alerts: [{ severity: "warning", component: "disk", message: "93%" }],
        metrics: {},
      }),
      { eventType: "health-check", agentId: "health-monitor" },
    );

    const identity = { ...getFrameworkIdentity(), workspace: WS };
    const payload = await buildPayloadV3(identity);

    const parsed = beatSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues, null, 2)).toBe(true);

    const health = payload.health as { status: string; alerts: number; alert_components: string[] };
    expect(health).not.toBeNull();
    expect(health.status).toBe("degraded");
    expect(health.alerts).toBe(1);
    expect(health.alert_components).toEqual(["disk"]);
  });

  it("collectors null-degrade: unknown workspace still yields a valid beat", async () => {
    const identity = { ...getFrameworkIdentity(), workspace: `vitest-216-empty-${randomUUID().slice(0, 6)}` };
    const payload = await buildPayloadV3(identity);
    expect(beatSchema.safeParse(payload).success).toBe(true);
    expect(payload.health).toBeNull();
  });

  it("every payload field is documented in the receiver contract", async () => {
    const contract = readFileSync(join(__dirname, "..", "docs", "fleet-heartbeat-contract.md"), "utf-8");
    const identity = { ...getFrameworkIdentity(), workspace: WS };
    const payload = await buildPayloadV3(identity);
    for (const field of Object.keys(payload)) {
      expect(
        contract.includes(`\`${field}\``),
        `payload field '${field}' missing from docs/fleet-heartbeat-contract.md`,
      ).toBe(true);
    }
  });
});
