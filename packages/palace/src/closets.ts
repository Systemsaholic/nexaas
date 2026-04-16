export interface Closet {
  id: string;
  workspace: string;
  wing: string;
  hall: string;
  room: string;
  topic: string;
  entities: string[];
  drawer_ids: string[];
  created_at: Date;
  normalize_version: number;
}
