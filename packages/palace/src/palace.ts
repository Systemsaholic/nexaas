import { createHash } from "crypto";
import { sql, sqlOne, sqlInTransaction } from "./db.js";
import type { Drawer, DrawerId, DrawerMeta, RoomPath, WalkOpts } from "./types.js";
import type { Closet } from "./closets.js";
import type { WaitpointToken, NotifyConfig } from "./waitpoints.js";
import type { WalEntry } from "./wal.js";
import { appendWal } from "./wal.js";

export interface PalaceContext {
  workspace: string;
  runId?: string;
  skillId?: string;
  stepId?: string;
  subAgentId?: string;
}

export interface PalaceSession {
  readonly ctx: PalaceContext;
  writeDrawer(room: RoomPath, content: string, meta?: DrawerMeta): Promise<DrawerId>;
  walkRoom(room: RoomPath, opts?: WalkOpts): Promise<Drawer[]>;
  openClosets(wing?: string): Promise<Closet[]>;
  createWaitpoint(args: {
    signal: string;
    room: RoomPath;
    state: Record<string, unknown>;
    timeout?: string;
    notify?: NotifyConfig;
  }): Promise<WaitpointToken>;
  wal(entry: Omit<WalEntry, "workspace">): Promise<void>;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseDuration(dur: string): number {
  const match = dur.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${dur}`);
  const [, val, unit] = match;
  const n = parseFloat(val!);
  switch (unit) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    case "d": return n * 86400 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

function createSession(ctx: PalaceContext): PalaceSession {
  return {
    ctx,

    async writeDrawer(room: RoomPath, content: string, meta?: DrawerMeta): Promise<DrawerId> {
      const hash = contentHash(content);
      // Cross-workspace write: use target workspace if declared, otherwise own workspace
      const targetWorkspace = room.workspace ?? meta?.target_workspace as string ?? ctx.workspace;
      const row = await sqlOne<{ id: string }>(
        `INSERT INTO nexaas_memory.events
          (workspace, wing, hall, room, content, content_hash, event_type, agent_id,
           skill_id, run_id, step_id, sub_agent_id, metadata,
           dormant_signal, dormant_until, reminder_at, normalize_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [
          targetWorkspace, room.wing, room.hall, room.room,
          content, hash, "drawer", ctx.skillId ?? "system",
          ctx.skillId, ctx.runId, ctx.stepId, ctx.subAgentId,
          JSON.stringify({ ...meta, source_workspace: ctx.workspace }),
          meta?.dormant_signal ?? null,
          meta?.dormant_until ?? null,
          meta?.reminder_at ?? null,
          meta?.normalize_version ?? 1,
        ],
      );

      // WAL audit for cross-workspace writes
      if (targetWorkspace !== ctx.workspace) {
        await appendWal({
          workspace: ctx.workspace,
          op: "cross_workspace_write",
          actor: ctx.skillId ?? "system",
          payload: {
            target_workspace: targetWorkspace,
            wing: room.wing, hall: room.hall, room: room.room,
            drawer_id: row!.id,
            run_id: ctx.runId,
          },
        });
      }

      return row!.id;
    },

    async walkRoom(room: RoomPath, opts?: WalkOpts): Promise<Drawer[]> {
      // Cross-workspace read: use declared workspace if present, otherwise own
      const targetWorkspace = room.workspace ?? ctx.workspace;
      const conditions = [
        "workspace = $1",
        "wing = $2",
        "hall = $3",
        "room = $4",
      ];
      const params: unknown[] = [targetWorkspace, room.wing, room.hall, room.room];
      let paramIdx = 5;

      if (opts?.since) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(opts.since);
        paramIdx++;
      }

      const limit = opts?.limit ?? 100;
      conditions.push(`dormant_signal IS NULL`);

      const query = `
        SELECT * FROM nexaas_memory.events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${paramIdx}
      `;
      params.push(limit);

      return sql<Drawer>(query, params);
    },

    async openClosets(wing?: string): Promise<Closet[]> {
      if (wing) {
        return sql<Closet>(
          `SELECT * FROM nexaas_memory.closets WHERE workspace = $1 AND wing = $2`,
          [ctx.workspace, wing],
        );
      }
      return sql<Closet>(
        `SELECT * FROM nexaas_memory.closets WHERE workspace = $1`,
        [ctx.workspace],
      );
    },

    async createWaitpoint(args): Promise<WaitpointToken> {
      const timeoutMs = args.timeout ? parseDuration(args.timeout) : 7 * 86400 * 1000;
      const dormantUntil = new Date(Date.now() + timeoutMs);

      const drawerId = await this.writeDrawer(args.room, JSON.stringify(args.state), {
        dormant_signal: args.signal,
        dormant_until: dormantUntil,
        ...args.notify ? { notify: args.notify } as DrawerMeta : {},
      });

      return {
        signal: args.signal,
        drawerId,
        dormantUntil,
        room: args.room,
      };
    },

    async wal(entry: Omit<WalEntry, "workspace">): Promise<void> {
      await appendWal({ ...entry, workspace: ctx.workspace });
    },
  };
}

export const palace = {
  enter(ctx: PalaceContext): PalaceSession {
    return createSession(ctx);
  },
};

export async function resolveWaitpoint(
  signal: string,
  resolution: Record<string, unknown>,
  actor: string,
): Promise<{ runId: string; skillId: string; stepId: string }> {
  const drawer = await sqlOne<Drawer>(
    `SELECT * FROM nexaas_memory.events
     WHERE dormant_signal = $1
     LIMIT 1`,
    [signal],
  );

  if (!drawer) {
    throw new Error(`Waitpoint not found: ${signal}`);
  }

  await sql(
    `UPDATE nexaas_memory.events
     SET dormant_signal = NULL, dormant_until = NULL
     WHERE id = $1`,
    [drawer.id],
  );

  const session = createSession({
    workspace: drawer.workspace,
    runId: drawer.run_id,
    skillId: drawer.skill_id,
  });

  await session.writeDrawer(
    { wing: drawer.wing, hall: drawer.hall, room: drawer.room },
    JSON.stringify({ resolution, actor, resolved_at: new Date().toISOString() }),
    { run_id: drawer.run_id, step_id: drawer.step_id } as DrawerMeta,
  );

  await appendWal({
    workspace: drawer.workspace,
    op: "waitpoint_resolved",
    actor,
    payload: { signal, resolution, drawer_id: drawer.id },
  });

  return {
    runId: drawer.run_id!,
    skillId: drawer.skill_id!,
    stepId: drawer.step_id!,
  };
}
