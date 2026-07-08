// Regression harness for #254 — WAL canonicalization v2.
// Proves: v2 hashes nested payloads (nested tamper detected), v1 legacy rows
// still verify, mixed v1/v2 chains verify, exempt rows skip, top-level tamper
// still caught. Run: DATABASE_URL=... node --import tsx scripts/test-wal-canon-254.mjs
import { createHash } from "crypto";
import pg from "pg";
import { applyPendingMigrations } from "../packages/cli/src/migrations.js";
import { appendWal, verifyWalChain, createPool, sql } from "../packages/palace/src/index.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };

const WS = "walcanon";
const repoRoot = new URL("..", import.meta.url).pathname;
const migPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
// applyPendingMigrations reports failure via result.failed, it does NOT throw
const mig = await applyPendingMigrations(migPool, repoRoot, () => {});
if (mig.failed) {
  console.error(`migration ${mig.failed.filename} failed: ${mig.failed.error}`);
  process.exit(1);
}
// confirm 029 landed
const col = await migPool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='nexaas_memory' AND table_name='wal' AND column_name='canon_version'`);
ok(col.rowCount === 1, "migration 029: canon_version column exists");
const fn = await migPool.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='nexaas_memory' AND p.proname='wal_hash_v2'`);
ok(fn.rowCount === 1, "migration 029: wal_hash_v2 function exists");
await migPool.end();
createPool();

// 1. v2 write with a NESTED payload, verify clean
await appendWal({ workspace: WS, op: "seed", actor: "t", payload: { n: 1 } });
await appendWal({ workspace: WS, op: "invoice", actor: "t", payload: { meta: { amount: 9999, vendor: "acme" }, top: "x" } });
await appendWal({ workspace: WS, op: "seed", actor: "t", payload: { n: 2 } });
let v = await verifyWalChain(WS);
ok(v.valid, "v2 chain with nested payloads verifies clean");
const cv = await sql(`SELECT DISTINCT canon_version FROM nexaas_memory.wal WHERE workspace=$1`, [WS]);
ok(cv.length === 1 && Number(cv[0].canon_version) === 2, "appendWal stamps canon_version=2");

// 2. THE SECURITY FIX — tamper a NESTED field, verify must break at that row
const inv = (await sql(`SELECT id FROM nexaas_memory.wal WHERE workspace=$1 AND op='invoice'`, [WS]))[0].id;
await sql(`UPDATE nexaas_memory.wal SET payload = jsonb_set(payload, '{meta,amount}', '1') WHERE id=$1`, [inv]);
v = await verifyWalChain(WS);
ok(v.valid === false && String(v.brokenAt) === String(inv), "NESTED tamper detected (v2) — the #254 fix");
// restore
await sql(`UPDATE nexaas_memory.wal SET payload = jsonb_set(payload, '{meta,amount}', '9999') WHERE id=$1`, [inv]);
ok((await verifyWalChain(WS)).valid, "restore → verifies again");

// 3. v1 legacy row still verifies (mixed chain). Insert a row exactly as old appendWal did.
const prev = (await sql(`SELECT hash FROM nexaas_memory.wal WHERE workspace=$1 ORDER BY id DESC LIMIT 1`, [WS]))[0].hash;
const created = "2026-07-02T10:00:00.000Z";
const payloadV1 = { b: 2, a: 1 };
const canonV1 = [prev, "legacy_op", "t", JSON.stringify(payloadV1, Object.keys(payloadV1).sort()), created].join("|");
const hashV1 = createHash("sha256").update(canonV1).digest("hex");
await sql(`INSERT INTO nexaas_memory.wal (workspace,op,actor,payload,prev_hash,hash,canon_version,created_at) VALUES ($1,'legacy_op','t',$2::jsonb,$3,$4,1,$5::timestamptz)`,
  [WS, JSON.stringify(payloadV1), prev, hashV1, created]);
v = await verifyWalChain(WS);
ok(v.valid, "mixed chain: v1 legacy row verifies under canonicalizeV1");
// append another v2 AFTER the v1 row — chain continues
await appendWal({ workspace: WS, op: "after_legacy", actor: "t", payload: { ok: true } });
ok((await verifyWalChain(WS)).valid, "v2 row appended after v1 row — chain intact");

// 4. exempt: a pre-029 bogus CLI row (bogus hash) breaks verify unless flagged
const prev2 = (await sql(`SELECT hash FROM nexaas_memory.wal WHERE workspace=$1 ORDER BY id DESC LIMIT 1`, [WS]))[0].hash;
const bogus = await sql(`INSERT INTO nexaas_memory.wal (workspace,op,actor,payload,prev_hash,hash,canon_version) VALUES ($1,'library_contribute','nexaas-cli','{"x":1}'::jsonb,$2,encode(digest('bogus','sha256'),'hex'),1) RETURNING id`, [WS, prev2]);
const bogusId = bogus[0].id;
v = await verifyWalChain(WS);
ok(v.valid === false && String(v.brokenAt) === String(bogusId), "unflagged bogus CLI row breaks verify");
await sql(`UPDATE nexaas_memory.wal SET integrity_exempt=true WHERE id=$1`, [bogusId]);
v = await verifyWalChain(WS);
ok(v.valid && v.exemptSkipped >= 1, "flagged exempt (as migration 029 does) → skipped, chain valid");

// 5. C1: appendWal-written library_contribute (v2) verifies (not exempt)
await appendWal({ workspace: WS, op: "library_contribute", actor: "nexaas-cli", payload: { skill_id: "marketing/x", version: "1.0.0" } });
ok((await verifyWalChain(WS)).valid, "new appendWal library_contribute (v2) verifies");

// 6. top-level tamper still caught (v2)
const last = (await sql(`SELECT id FROM nexaas_memory.wal WHERE workspace=$1 ORDER BY id DESC LIMIT 1`, [WS]))[0].id;
await sql(`UPDATE nexaas_memory.wal SET payload = jsonb_set(payload, '{version}', '"9.9.9"') WHERE id=$1`, [last]);
v = await verifyWalChain(WS);
ok(v.valid === false && String(v.brokenAt) === String(last), "top-level tamper still detected (v2)");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
