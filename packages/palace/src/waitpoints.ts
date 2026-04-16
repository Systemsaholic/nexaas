import type { RoomPath } from "./types.js";

export interface NotifyConfig {
  channel_role: string;
  timeout?: string;
  on_timeout?: "escalate" | "auto_approve" | "auto_reject" | "auto_cancel" | "remind_and_extend";
  reminder_before?: string;
  reminder_channel?: string;
  keywords?: Record<string, string[]>;
}

export interface WaitpointToken {
  signal: string;
  drawerId: string;
  dormantUntil: Date;
  room: RoomPath;
}
