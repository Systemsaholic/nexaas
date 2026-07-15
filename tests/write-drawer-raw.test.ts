/**
 * writeDrawerRaw (#256) — the single drawer INSERT all system writers
 * share. DB-gated like the [db] harnesses: skips without DATABASE_URL.
 * Uses a throwaway workspace id and deletes its own rows.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getPool, palace, sql, writeDrawerRaw } from "../packages/palace/src/index.js";

const hasDb = !!process.env.DATABASE_URL;
const WS = `vitest-256-${process.pid}`;

afterAll(async () => {
  if (!hasDb) return;
  await sql(`DELETE FROM nexaas_memory.events WHERE workspace = $1`, [WS]);
  await getPool().end().catch(() => {});
});

describe.skipIf(!hasDb)("writeDrawerRaw", () => {
  it("writes a drawer with defaults (event_type drawer, agent system, normalize_version 1)", async () => {
    const id = await writeDrawerRaw(WS, { wing: "ops", hall: "test", room: "raw" }, "hello");
    const [row] = await sql<Record<string, unknown>>(
      `SELECT * FROM nexaas_memory.events WHERE id = $1::uuid`, [id],
    );
    expect(row).toBeDefined();
    expect(row!.event_type).toBe("drawer");
    expect(row!.agent_id).toBe("system");
    expect(row!.normalize_version).toBe(1);
    expect(row!.content).toBe("hello");
    // default content_hash = sha256(content)
    expect(row!.content_hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("honors the contentHash override (library files-map dedupe key)", async () => {
    const id = await writeDrawerRaw(
      WS, { wing: "library", hall: "test", room: "dedupe" }, "content-with-timestamp",
      { eventType: "skill-registration", agentId: "library", contentHash: "feed".repeat(16) },
    );
    const [row] = await sql<Record<string, unknown>>(
      `SELECT event_type, content_hash FROM nexaas_memory.events WHERE id = $1::uuid`, [id],
    );
    expect(row!.event_type).toBe("skill-registration");
    expect(row!.content_hash).toBe("feed".repeat(16));
  });

  it("backs PalaceSession.writeDrawer with identical row shape", async () => {
    const session = palace.enter({ workspace: WS, skillId: "ops/tester", runId: undefined });
    const id = await session.writeDrawer({ wing: "ops", hall: "test", room: "session" }, "via-session", { foo: "bar" } as never);
    const [row] = await sql<Record<string, unknown>>(
      `SELECT * FROM nexaas_memory.events WHERE id = $1::uuid`, [id],
    );
    expect(row!.event_type).toBe("drawer");
    expect(row!.agent_id).toBe("ops/tester");
    expect(row!.skill_id).toBe("ops/tester");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.foo).toBe("bar");
    expect(meta.source_workspace).toBe(WS);
  });
});
