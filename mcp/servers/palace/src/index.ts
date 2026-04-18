/**
 * Nexaas Palace MCP Server
 *
 * Gives every Claude Code session and every PA live access to the Nexaas
 * memory palace. This is the foundation for all AI interactions on the
 * workspace — scheduled skills, interactive sessions, and conversational agents
 * all use the same palace substrate through this MCP.
 *
 * Tools:
 *   palace_context   — Read drawers from a palace room
 *   palace_search    — Semantic search across rooms
 *   palace_recent    — Recent activity for a skill or room
 *   palace_write     — Write a drawer to a room
 *   palace_rooms     — List rooms with drawer counts
 *   palace_run_history — Recent skill run results
 *   palace_wal       — Recent WAL entries (audit trail)
 *   palace_config    — Workspace configuration
 *
 * Transport: stdio (add to .mcp.json for Claude Code sessions)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";

// ── Database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? process.env.NEXAAS_PALACE_DB,
  max: 5,
  idleTimeoutMillis: 30_000,
});

const WORKSPACE = process.env.NEXAAS_WORKSPACE ?? "default";

async function sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: "nexaas-palace",
  version: "0.1.0",
});

// ── palace_context: Read drawers from a room ────────────────────────────

server.tool(
  "palace_context",
  "Read drawers from a specific palace room. Use wing/hall/room path to scope the query. Returns the most recent drawers.",
  {
    wing: z.string().describe("Top-level wing (e.g., knowledge, marketing, operations, inbox, events, ops)"),
    hall: z.string().describe("Hall within the wing (e.g., brand, suppliers, email, crm)"),
    room: z.string().describe("Specific room (e.g., voice, sorting, triage)"),
    limit: z.number().optional().default(10).describe("Max drawers to return (default 10)"),
    workspace: z.string().optional().describe("Workspace ID (default: current workspace)"),
  },
  async ({ wing, hall, room, limit, workspace }) => {
    const ws = workspace ?? WORKSPACE;
    const drawers = await sql(
      `SELECT id::text, content, skill_id, run_id::text, created_at::text
       FROM nexaas_memory.events
       WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4
         AND dormant_signal IS NULL
       ORDER BY created_at DESC
       LIMIT $5`,
      [ws, wing, hall, room, limit],
    );
    return jsonResult({ room: `${wing}/${hall}/${room}`, count: drawers.length, drawers });
  },
);

// ── palace_search: Semantic or keyword search ───────────────────────────

server.tool(
  "palace_search",
  "Search the palace for drawers matching a query. Searches across all rooms or a specific wing. Uses text matching (semantic search available when Voyage embeddings are configured).",
  {
    query: z.string().describe("Search query — keywords or natural language"),
    wing: z.string().optional().describe("Limit search to a specific wing"),
    limit: z.number().optional().default(10).describe("Max results (default 10)"),
  },
  async ({ query, wing, limit }) => {
    const conditions = ["workspace = $1", "content ILIKE $2"];
    const params: unknown[] = [WORKSPACE, `%${query}%`];

    if (wing) {
      conditions.push("wing = $3");
      params.push(wing);
    }

    const results = await sql(
      `SELECT id::text, wing, hall, room, left(content, 300) as content_preview,
              skill_id, created_at::text
       FROM nexaas_memory.events
       WHERE ${conditions.join(" AND ")}
         AND wing IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return jsonResult({ query, results_count: results.length, results });
  },
);

// ── palace_recent: Recent activity for a skill or room ──────────────────

server.tool(
  "palace_recent",
  "Get recent activity — skill runs, drawer writes, or WAL entries for a specific skill or across the workspace.",
  {
    skill_id: z.string().optional().describe("Filter by skill ID (e.g., operations/info-inbox-sorter)"),
    hours: z.number().optional().default(24).describe("Look back N hours (default 24)"),
    limit: z.number().optional().default(20).describe("Max entries (default 20)"),
  },
  async ({ skill_id, hours, limit }) => {
    const conditions = ["workspace = $1", `created_at > now() - interval '${hours} hours'`];
    const params: unknown[] = [WORKSPACE];

    if (skill_id) {
      conditions.push(`skill_id = $${params.length + 1}`);
      params.push(skill_id);
    }

    const drawers = await sql(
      `SELECT id::text, wing, hall, room, left(content, 200) as content_preview,
              skill_id, run_id::text, created_at::text
       FROM nexaas_memory.events
       WHERE ${conditions.join(" AND ")}
         AND wing IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return jsonResult({ skill_id: skill_id ?? "all", hours, count: drawers.length, drawers });
  },
);

// ── palace_write: Write a drawer to the palace ──────────────────────────

server.tool(
  "palace_write",
  "Write a drawer (memory record) to a palace room. Use this to record work, decisions, context, or any information that should persist for future AI sessions.",
  {
    wing: z.string().describe("Target wing"),
    hall: z.string().describe("Target hall"),
    room: z.string().describe("Target room"),
    content: z.string().describe("Content to store — text, JSON, notes, whatever should be remembered"),
    skill_id: z.string().optional().describe("Skill ID that produced this (optional)"),
  },
  async ({ wing, hall, room, content, skill_id }) => {
    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(content).digest("hex");

    const result = await sql<{ id: string }>(
      `INSERT INTO nexaas_memory.events
        (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'drawer', 'palace-mcp', $7)
       RETURNING id::text`,
      [WORKSPACE, wing, hall, room, content, hash, skill_id ?? "interactive"],
    );

    // WAL entry for audit
    await sql(
      `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
       SELECT $1, 'palace_mcp_write', 'palace-mcp',
         $2::jsonb,
         COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
         encode(digest($4, 'sha256'), 'hex')`,
      [
        WORKSPACE,
        JSON.stringify({ wing, hall, room, drawer_id: result[0]?.id, content_length: content.length }),
        "0".repeat(64),
        `palace-write-${Date.now()}`,
      ],
    );

    return jsonResult({
      written: true,
      room: `${wing}/${hall}/${room}`,
      drawer_id: result[0]?.id,
    });
  },
);

// ── palace_rooms: List rooms with drawer counts ─────────────────────────

server.tool(
  "palace_rooms",
  "List all palace rooms in the workspace with drawer counts. Useful for discovering what context is available.",
  {
    wing: z.string().optional().describe("Filter by wing (optional — omit to see all wings)"),
  },
  async ({ wing }) => {
    const conditions = ["workspace = $1", "wing IS NOT NULL"];
    const params: unknown[] = [WORKSPACE];

    if (wing) {
      conditions.push("wing = $2");
      params.push(wing);
    }

    const rooms = await sql(
      `SELECT wing, hall, room, count(*) as drawer_count,
              max(created_at)::text as last_activity
       FROM nexaas_memory.events
       WHERE ${conditions.join(" AND ")}
       GROUP BY wing, hall, room
       ORDER BY wing, hall, room`,
      params,
    );
    return jsonResult({ workspace: WORKSPACE, room_count: rooms.length, rooms });
  },
);

// ── palace_run_history: Recent skill runs ────────────────────────────────

server.tool(
  "palace_run_history",
  "View recent skill run results — completions, failures, costs, and durations. Useful for debugging skills or understanding workspace activity.",
  {
    skill_id: z.string().optional().describe("Filter by skill ID"),
    status: z.string().optional().describe("Filter by status: completed, failed, running"),
    limit: z.number().optional().default(20).describe("Max runs to return"),
  },
  async ({ skill_id, status, limit }) => {
    const conditions = ["workspace = $1"];
    const params: unknown[] = [WORKSPACE];

    if (skill_id) {
      conditions.push(`skill_id = $${params.length + 1}`);
      params.push(skill_id);
    }
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    const runs = await sql(
      `SELECT run_id::text, skill_id, skill_version, status, trigger_type,
              started_at::text, completed_at::text, error_summary,
              token_usage
       FROM nexaas_memory.skill_runs
       WHERE ${conditions.join(" AND ")}
       ORDER BY started_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return jsonResult({ count: runs.length, runs });
  },
);

// ── palace_wal: Recent WAL entries ──────────────────────────────────────

server.tool(
  "palace_wal",
  "View recent WAL (Write-Ahead Log) entries — the audit trail of everything that happened in the workspace. Shows operations, actors, and timestamps.",
  {
    limit: z.number().optional().default(20).describe("Max entries to return"),
    op: z.string().optional().describe("Filter by operation type (e.g., ai_skill_completed, agentic_turn)"),
  },
  async ({ limit, op }) => {
    const conditions = ["workspace = $1"];
    const params: unknown[] = [WORKSPACE];

    if (op) {
      conditions.push(`op = $${params.length + 1}`);
      params.push(op);
    }

    const entries = await sql(
      `SELECT id, op, actor, left(payload::text, 300) as payload_preview,
              created_at::text
       FROM nexaas_memory.wal
       WHERE ${conditions.join(" AND ")}
       ORDER BY id DESC
       LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return jsonResult({ count: entries.length, entries });
  },
);

// ── palace_config: Workspace configuration ──────────────────────────────

server.tool(
  "palace_config",
  "View workspace configuration — timezone, display name, default model tier, and workspace root path.",
  {},
  async () => {
    const config = await sql(
      `SELECT workspace, timezone, display_name, default_model_tier, workspace_root,
              created_at::text, updated_at::text
       FROM nexaas_memory.workspace_config
       WHERE workspace = $1`,
      [WORKSPACE],
    );

    const skills = await sql(
      `SELECT skill_id, status, count(*) as runs
       FROM nexaas_memory.skill_runs
       WHERE workspace = $1
       GROUP BY skill_id, status
       ORDER BY skill_id`,
      [WORKSPACE],
    );

    const walCount = await sql<{ count: string }>(
      `SELECT count(*) FROM nexaas_memory.wal WHERE workspace = $1`,
      [WORKSPACE],
    );

    return jsonResult({
      config: config[0] ?? { workspace: WORKSPACE, timezone: "UTC" },
      skill_summary: skills,
      wal_entries: parseInt(walCount[0]?.count ?? "0", 10),
    });
  },
);

// ── Start ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[nexaas-palace] Fatal:", err);
  process.exit(1);
});
