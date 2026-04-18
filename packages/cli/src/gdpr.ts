/**
 * nexaas gdpr — PII management and data subject rights.
 *
 * Commands:
 *   nexaas gdpr export <email>     Export all data for a subject
 *   nexaas gdpr delete <email>     Cryptographic erasure (revoke PII key)
 *   nexaas gdpr redact <drawer-id> Tombstone-redact a specific drawer
 *   nexaas gdpr subjects           List known data subjects
 *   nexaas gdpr audit              Show GDPR action history
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import pg from "pg";

export async function run(args: string[]) {
  const subcommand = args[0];
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  switch (subcommand) {
    case "export": {
      const email = args[1];
      if (!email) {
        console.error("Usage: nexaas gdpr export <email>");
        process.exit(1);
      }

      console.log(`\n  GDPR Data Export: ${email}\n`);

      // Find subject
      const subject = await pool.query(
        `SELECT * FROM nexaas_memory.pii_subjects
         WHERE workspace = $1 AND identifiers @> $2::jsonb`,
        [workspace, JSON.stringify({ email })],
      );

      if (subject.rows.length === 0) {
        console.log("  No data subject found for this email.");
        console.log("  Checking palace for any matching content...\n");
      }

      // Search palace drawers for content mentioning this email
      const drawers = await pool.query(
        `SELECT id, wing, hall, room, content, created_at::text
         FROM nexaas_memory.events
         WHERE workspace = $1
           AND (content ILIKE $2 OR metadata::text ILIKE $2)
         ORDER BY created_at DESC
         LIMIT 100`,
        [workspace, `%${email}%`],
      );

      console.log(`  Found ${drawers.rows.length} drawer(s) containing this email.\n`);

      for (const d of drawers.rows) {
        console.log(`  [${d.created_at}] ${d.wing}/${d.hall}/${d.room}`);
        console.log(`    Drawer ID: ${d.id}`);
        const preview = (d.content ?? "").slice(0, 120).replace(/\n/g, " ");
        console.log(`    Preview: ${preview}...`);
        console.log("");
      }

      // WAL entries
      const walEntries = await pool.query(
        `SELECT id, op, actor, created_at::text, left(payload::text, 100) as payload_preview
         FROM nexaas_memory.wal
         WHERE workspace = $1 AND payload::text ILIKE $2
         ORDER BY created_at DESC LIMIT 50`,
        [workspace, `%${email}%`],
      );

      if (walEntries.rows.length > 0) {
        console.log(`  WAL entries: ${walEntries.rows.length}\n`);
      }

      // Operator record
      const operator = await pool.query(
        `SELECT id, role, workspace_scope, created_at::text
         FROM nexaas_memory.operators
         WHERE email = $1`,
        [email],
      );

      if (operator.rows.length > 0) {
        console.log(`  Operator record: yes (role: ${operator.rows[0].role})`);
      }

      // Log the export
      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'gdpr_export', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          workspace,
          JSON.stringify({ subject_email: email, drawers_found: drawers.rows.length, wal_entries: walEntries.rows.length }),
          "0".repeat(64),
          `gdpr-export-${email}-${Date.now()}`,
        ],
      );

      console.log(`\n  Export logged to WAL.\n`);
      break;
    }

    case "delete": {
      const email = args[1];
      if (!email) {
        console.error("Usage: nexaas gdpr delete <email>");
        process.exit(1);
      }

      console.log(`\n  GDPR Erasure: ${email}\n`);
      console.log("  This performs cryptographic erasure — PII keys are revoked,");
      console.log("  making encrypted PII unrecoverable.\n");

      // Revoke any PII keys
      const revoked = await pool.query(
        `UPDATE nexaas_memory.pii_keys
         SET revoked_at = now(), revoked_reason = 'GDPR deletion request'
         WHERE workspace = $1 AND subject_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [workspace, email],
      );

      console.log(`  PII keys revoked: ${revoked.rows.length}`);

      // Tombstone drawers containing this email
      const tombstoned = await pool.query(
        `UPDATE nexaas_memory.events
         SET content = '{"redacted": true, "reason": "GDPR deletion request", "original_hash": "' ||
           encode(digest(content, 'sha256'), 'hex') || '"}',
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gdpr_redacted}', 'true')
         WHERE workspace = $1
           AND content ILIKE $2
           AND wing NOT IN ('ops', 'notifications')
         RETURNING id`,
        [workspace, `%${email}%`],
      );

      console.log(`  Drawers tombstoned: ${tombstoned.rows.length}`);

      // Disable operator
      const disabled = await pool.query(
        `UPDATE nexaas_memory.operators
         SET disabled_at = now()
         WHERE email = $1 AND disabled_at IS NULL
         RETURNING id`,
        [email],
      );

      if (disabled.rows.length > 0) {
        console.log(`  Operator disabled: yes`);
      }

      // Register subject deletion
      await pool.query(
        `INSERT INTO nexaas_memory.pii_subjects (workspace, subject_type, identifiers)
         VALUES ($1, 'deleted', $2)
         ON CONFLICT DO NOTHING`,
        [workspace, JSON.stringify({ email, deleted_at: new Date().toISOString() })],
      );

      // WAL audit
      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'gdpr_delete', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          workspace,
          JSON.stringify({
            subject_email: email,
            keys_revoked: revoked.rows.length,
            drawers_tombstoned: tombstoned.rows.length,
            operator_disabled: disabled.rows.length > 0,
          }),
          "0".repeat(64),
          `gdpr-delete-${email}-${Date.now()}`,
        ],
      );

      console.log(`\n  ✓ Erasure complete. Logged to WAL.\n`);
      break;
    }

    case "redact": {
      const drawerId = args[1];
      if (!drawerId) {
        console.error("Usage: nexaas gdpr redact <drawer-id>");
        process.exit(1);
      }

      const drawer = await pool.query(
        `SELECT id, content, wing, hall, room
         FROM nexaas_memory.events
         WHERE id = $1::uuid AND workspace = $2`,
        [drawerId, workspace],
      );

      if (drawer.rows.length === 0) {
        console.error(`  Drawer ${drawerId} not found`);
        process.exit(1);
      }

      const d = drawer.rows[0];
      const originalHash = createHash("sha256").update(d.content ?? "").digest("hex");

      await pool.query(
        `UPDATE nexaas_memory.events
         SET content = $1,
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gdpr_redacted}', 'true')
         WHERE id = $2::uuid`,
        [
          JSON.stringify({ redacted: true, reason: "manual GDPR redaction", original_hash: originalHash }),
          drawerId,
        ],
      );

      // Record redaction
      await pool.query(
        `INSERT INTO nexaas_memory.pii_redactions
          (workspace, original_drawer_id, redacted_by, redaction_signature, reason)
         VALUES ($1, $2::uuid, (SELECT id FROM nexaas_memory.operators WHERE workspace_scope @> ARRAY[$1] LIMIT 1),
           decode($3, 'hex'), 'manual GDPR redaction')`,
        [workspace, drawerId, originalHash],
      );

      console.log(`\n  ✓ Drawer ${drawerId} redacted (${d.wing}/${d.hall}/${d.room})\n`);
      break;
    }

    case "subjects": {
      const subjects = await pool.query(
        `SELECT id, subject_type, identifiers, first_seen_at::text, last_seen_at::text
         FROM nexaas_memory.pii_subjects
         WHERE workspace = $1
         ORDER BY last_seen_at DESC LIMIT 50`,
        [workspace],
      );

      console.log("\n  Known Data Subjects\n");

      if (subjects.rows.length === 0) {
        console.log("  (none registered)\n");
        break;
      }

      for (const s of subjects.rows) {
        const ids = JSON.parse(JSON.stringify(s.identifiers));
        const display = ids.email ?? ids.name ?? JSON.stringify(ids).slice(0, 60);
        console.log(`  ${s.subject_type}: ${display} (${s.first_seen_at})`);
      }
      console.log("");
      break;
    }

    case "audit": {
      const actions = await pool.query(
        `SELECT op, actor, payload, created_at::text
         FROM nexaas_memory.wal
         WHERE workspace = $1 AND op LIKE 'gdpr_%'
         ORDER BY created_at DESC LIMIT 30`,
        [workspace],
      );

      console.log("\n  GDPR Audit Trail\n");

      if (actions.rows.length === 0) {
        console.log("  (no GDPR actions recorded)\n");
        break;
      }

      for (const a of actions.rows) {
        console.log(`  [${a.created_at}] ${a.op} by ${a.actor}`);
        const payload = typeof a.payload === "string" ? JSON.parse(a.payload) : a.payload;
        if (payload.subject_email) console.log(`    Subject: ${payload.subject_email}`);
        console.log("");
      }
      break;
    }

    default:
      console.log(`
  nexaas gdpr — PII management and data subject rights

  Commands:
    export <email>      Export all data for a subject (Art. 15)
    delete <email>      Cryptographic erasure + tombstone (Art. 17)
    redact <drawer-id>  Tombstone-redact a specific drawer
    subjects            List known data subjects
    audit               Show GDPR action history
`);
  }

  await pool.end();
}
