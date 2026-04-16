export type DrawerId = string;

export interface RoomPath {
  wing: string;
  hall: string;
  room: string;
  workspace?: string; // cross-workspace: read from or write to another workspace's rooms
}

export interface DrawerMeta {
  skill_id?: string;
  run_id?: string;
  step_id?: string;
  sub_agent_id?: string;
  dormant_signal?: string;
  dormant_until?: Date;
  reminder_at?: Date;
  normalize_version?: number;
  target_workspace?: string; // cross-workspace: event written for another workspace
  source_workspace?: string; // cross-workspace: tracks where a cross-workspace read came from
  [key: string]: unknown;
}

export interface Drawer {
  id: DrawerId;
  workspace: string;
  wing: string;
  hall: string;
  room: string;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  skill_id?: string;
  run_id?: string;
  step_id?: string;
  sub_agent_id?: string;
  dormant_signal?: string;
  dormant_until?: Date;
  reminder_at?: Date;
  reminder_sent: boolean;
  normalize_version: number;
  created_at: Date;
}

export interface WalkOpts {
  similar?: string;
  limit?: number;
  since?: Date;
  filter?: Record<string, unknown>;
}
