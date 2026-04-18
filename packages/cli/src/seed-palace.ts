/**
 * nexaas seed-palace — migrate workspace files into palace drawers.
 *
 * Reads files from the workspace and writes them as drawers
 * into the appropriate palace rooms. Idempotent — uses content hash
 * to skip files that are already in the palace.
 *
 * Usage:
 *   nexaas seed-palace                    Seed from NEXAAS_WORKSPACE_ROOT
 *   nexaas seed-palace --dry-run          Show what would be seeded without writing
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename, relative } from "path";
import { createHash } from "crypto";
import pg from "pg";

interface SeedEntry {
  filePath: string;
  wing: string;
  hall: string;
  room: string;
  priority: "high" | "medium" | "low";
  contentType: string;
}

function discoverSeedEntries(workspaceRoot: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  const ws = workspaceRoot;

  function addIfExists(filePath: string, wing: string, hall: string, room: string, priority: "high" | "medium" | "low", contentType: string) {
    if (existsSync(filePath)) {
      entries.push({ filePath, wing, hall, room, priority, contentType });
    }
  }

  function addDirFiles(dir: string, wing: string, hall: string, roomPrefix: string, ext: string, priority: "high" | "medium" | "low", contentType: string) {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(ext)) continue;
      const name = file.replace(ext, "");
      entries.push({
        filePath: join(dir, file),
        wing, hall,
        room: roomPrefix ? `${roomPrefix}-${name}` : name,
        priority, contentType,
      });
    }
  }

  // ── Phoenix-Voyages workspace ────────────────────────────────

  // Workspace context
  addIfExists(join(ws, "CLAUDE.md"), "knowledge", "context", "workspace-instructions", "high", "context");

  // Business registries
  addIfExists(join(ws, "registries", "business-info.yaml"), "knowledge", "context", "business-identity", "high", "config");
  addIfExists(join(ws, "registries", "advisors.yaml"), "knowledge", "context", "advisor-roster", "high", "data");
  addIfExists(join(ws, "registries", "suppliers.yaml"), "knowledge", "context", "supplier-roster", "high", "data");

  // Brand
  addIfExists(join(ws, "marketing", "BRAND-VOICE.md"), "knowledge", "brand", "voice", "high", "context");
  addIfExists(join(ws, "marketing", "compliance-learnings.md"), "knowledge", "brand", "compliance-learnings", "high", "rules");
  addIfExists(join(ws, "marketing", "IMAGE-CONTEXT-ALIGNMENT.md"), "knowledge", "brand", "image-alignment", "medium", "rules");

  // Agent prompts and configs
  const agentsDir = join(ws, "agents");
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, agent);
      if (!statSync(agentDir).isDirectory()) continue;
      addIfExists(join(agentDir, "prompt.md"), "knowledge", "agents", `${agent}-prompt`, "high", "context");
      addIfExists(join(agentDir, "config.yaml"), "knowledge", "agents", `${agent}-config`, "high", "config");
      addIfExists(join(agentDir, "DESIGN.md"), "knowledge", "agents", `${agent}-design`, "medium", "context");
    }
  }

  // TICO regulations
  const ticoDir = join(ws, "knowledge-base", "regulations", "tico");
  addDirFiles(ticoDir, "knowledge", "regulations", "tico", ".md", "high", "rules");

  // SOPs
  const sopDir = join(ws, "knowledge-base", "sops");
  addDirFiles(sopDir, "knowledge", "sops", "", ".md", "medium", "SOP");

  // Operational checks
  const checksDir = join(ws, "operations", "memory", "checks");
  addDirFiles(checksDir, "operations", "checks", "", ".yaml", "high", "config");

  // Followups and tracking
  addIfExists(join(ws, "operations", "memory", "followups.yaml"), "operations", "tracking", "followups", "high", "data");
  addIfExists(join(ws, "operations", "memory", "travel-alerts.yaml"), "operations", "alerts", "travel", "medium", "data");
  addIfExists(join(ws, "operations", "memory", "recent-actions.yaml"), "operations", "tracking", "recent-actions", "medium", "data");
  addIfExists(join(ws, "operations", "memory", "frequency-guidance.yaml"), "operations", "config", "frequency-guidance", "medium", "config");

  // PA commitments
  const paDir = join(ws, "operations", "memory", "pa");
  if (existsSync(paDir)) {
    for (const person of readdirSync(paDir)) {
      const personDir = join(paDir, person);
      if (!statSync(personDir).isDirectory()) continue;
      addIfExists(join(personDir, "commitments.yaml"), "operations", "pa", `${person}-commitments`, "high", "data");
      addIfExists(join(personDir, "inbox-digest.yaml"), "operations", "pa", `${person}-inbox-digest`, "medium", "data");
    }
  }

  // Runbooks
  const runbooksDir = join(ws, "operations", "runbooks");
  addDirFiles(runbooksDir, "knowledge", "runbooks", "", ".md", "high", "SOP");

  // Email templates
  const emailTemplatesDir = join(ws, "marketing", "email-templates", "complete");
  addDirFiles(emailTemplatesDir, "knowledge", "templates", "email", ".html", "medium", "template");

  // Marketing templates
  const marketingTemplatesDir = join(ws, "marketing", "templates");
  addDirFiles(marketingTemplatesDir, "knowledge", "templates", "social", ".yaml", "medium", "template");

  // Social frequency
  addIfExists(join(ws, "marketing", "social", "frequency-guidance.yaml"), "operations", "config", "social-frequency", "medium", "config");

  // Recruitment
  addIfExists(join(ws, "recruitment", "onboarding-workflow.yaml"), "knowledge", "hr", "onboarding-workflow", "medium", "SOP");
  addIfExists(join(ws, "recruitment", "onboarding-checklist.md"), "knowledge", "hr", "onboarding-checklist", "medium", "SOP");
  addIfExists(join(ws, "recruitment", "qualification-checklist.md"), "knowledge", "hr", "qualification-checklist", "medium", "SOP");

  // Reference docs
  addIfExists(join(ws, "reference", "MCP-SERVERS.md"), "knowledge", "infrastructure", "mcp-servers", "medium", "context");
  addIfExists(join(ws, "reference", "INFRASTRUCTURE.md"), "knowledge", "infrastructure", "overview", "medium", "context");

  // QC rules
  const qcRulesDir = join(ws, "agents", "qc", "rules");
  addDirFiles(qcRulesDir, "knowledge", "agents", "qc-rules", ".yaml", "high", "rules");

  // Landing page registry
  addIfExists(join(ws, "data", "landing-page-registry.yaml"), "operations", "web", "landing-page-registry", "medium", "data");

  // Groups
  addIfExists(join(ws, "groups", "index.yaml"), "operations", "groups", "index", "medium", "data");

  // ── Accounting workspace ─────────────────────────────────────

  const acctRoot = join(ws, "..", "Accounting");
  if (existsSync(acctRoot)) {
    addIfExists(join(acctRoot, "CLAUDE.md"), "knowledge", "context", "accounting-instructions", "high", "context");
    addIfExists(join(acctRoot, "bookkeeping", "rules.yaml"), "knowledge", "accounting", "categorization-rules", "high", "rules");
    addIfExists(join(acctRoot, "bookkeeping", "chart-of-accounts.yaml"), "knowledge", "accounting", "chart-of-accounts", "high", "rules");
    addIfExists(join(acctRoot, "bookkeeping", "accounts.yaml"), "knowledge", "accounting", "bank-accounts", "high", "config");
    addIfExists(join(acctRoot, "bookkeeping", "tax_codes.yaml"), "knowledge", "accounting", "tax-codes", "high", "rules");
    addIfExists(join(acctRoot, "bookkeeping", "receipt_rules.yaml"), "knowledge", "accounting", "receipt-rules", "high", "rules");
    addIfExists(join(acctRoot, "bookkeeping", "commission_suppliers.yaml"), "knowledge", "accounting", "commission-suppliers", "high", "data");
    addIfExists(join(acctRoot, "bookkeeping", "intercompany.yaml"), "knowledge", "accounting", "intercompany", "high", "rules");
    addIfExists(join(acctRoot, "bookkeeping", "etransfer_registry.yaml"), "operations", "accounting", "etransfer-registry", "medium", "data");
    addIfExists(join(acctRoot, "bookkeeping", "loan_registry.yaml"), "operations", "accounting", "loan-registry", "medium", "data");
    addIfExists(join(acctRoot, "trust", "trust_ledger.yaml"), "operations", "accounting", "trust-ledger", "high", "data");
    addIfExists(join(acctRoot, "tax", "hst_registry.yaml"), "operations", "accounting", "hst-registry", "medium", "data");
    addIfExists(join(acctRoot, "tax", "ita_payment_registry.yaml"), "operations", "accounting", "ita-payments", "medium", "data");
    addIfExists(join(acctRoot, "reconciliation", "trust-account-reconciliation.yaml"), "operations", "accounting", "trust-reconciliation", "medium", "data");
    addIfExists(join(acctRoot, "reconciliation", "stripe-payout-registry.yaml"), "operations", "accounting", "stripe-payouts", "medium", "data");

    // Accounting SOPs
    const acctDocsDir = join(acctRoot, "docs");
    if (existsSync(acctDocsDir)) {
      for (const file of readdirSync(acctDocsDir)) {
        if (file.endsWith(".md")) {
          entries.push({
            filePath: join(acctDocsDir, file),
            wing: "knowledge",
            hall: "accounting",
            room: `sop-${file.replace(".md", "")}`,
            priority: "high",
            contentType: "SOP",
          });
        }
      }
    }
  }

  return entries;
}

export async function run(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const highOnly = args.includes("--high-only");
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;

  if (!workspaceRoot || !workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE_ROOT, NEXAAS_WORKSPACE, and DATABASE_URL are required");
    process.exit(1);
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║       Nexaas Palace Seeding              ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  const entries = discoverSeedEntries(workspaceRoot);
  const filtered = highOnly ? entries.filter(e => e.priority === "high") : entries;

  console.log(`  Workspace: ${workspace}`);
  console.log(`  Root: ${workspaceRoot}`);
  console.log(`  Discovered: ${entries.length} files (${entries.filter(e => e.priority === "high").length} high, ${entries.filter(e => e.priority === "medium").length} medium, ${entries.filter(e => e.priority === "low").length} low)`);
  console.log(`  Seeding: ${filtered.length} files${highOnly ? " (high priority only)" : ""}${dryRun ? " (DRY RUN)" : ""}\n`);

  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });

  let seeded = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of filtered) {
    try {
      const content = readFileSync(entry.filePath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      const relPath = relative(workspaceRoot, entry.filePath);

      if (dryRun) {
        console.log(`  → ${entry.wing}/${entry.hall}/${entry.room} ← ${relPath} (${content.length} chars)`);
        seeded++;
        continue;
      }

      // Check if already seeded (by content hash)
      const existing = await pool.query(
        `SELECT id FROM nexaas_memory.events WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4 AND content_hash = $5 LIMIT 1`,
        [workspace, entry.wing, entry.hall, entry.room, hash],
      );

      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      // Write drawer
      await pool.query(
        `INSERT INTO nexaas_memory.events (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, 'seed', 'palace-seed', $7, $8)`,
        [
          workspace, entry.wing, entry.hall, entry.room,
          content, hash,
          `seed/${entry.contentType}`,
          JSON.stringify({ source_file: relPath, priority: entry.priority, content_type: entry.contentType }),
        ],
      );

      console.log(`  ✓ ${entry.wing}/${entry.hall}/${entry.room} ← ${relPath}`);
      seeded++;
    } catch (err) {
      console.error(`  ✗ ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  console.log(`\n  Results: ${seeded} seeded, ${skipped} skipped (already in palace), ${errors} errors`);

  if (!dryRun && seeded > 0) {
    await pool.query(
      `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
       SELECT $1, 'palace_seeded', 'nexaas-cli', $2::jsonb,
         COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
         encode(digest($4, 'sha256'), 'hex')`,
      [
        workspace,
        JSON.stringify({ files_seeded: seeded, files_skipped: skipped, errors }),
        "0".repeat(64),
        `seed-${Date.now()}`,
      ],
    );
    console.log(`  WAL entry recorded\n`);
  } else {
    console.log("");
  }

  await pool.end();
}
