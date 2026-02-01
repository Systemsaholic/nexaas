// ---------------------------------------------------------------------------
// Gateway API types for AI Mission Control
// ---------------------------------------------------------------------------

export interface Workspace {
  name: string;
  description: string;
  registries: string[];
  perspectives: Perspective[];
  pages: PageConfig[];
}

export interface Perspective {
  id: string;
  name: string;
  icon: string;
  pages: PageConfig[];
  default_page: string;
}

export interface PageConfig {
  id: string;
  name: string;
  icon: string;
  layout: string;
  components: ComponentConfig[];
}

export interface ComponentConfig {
  type: string;
  title: string;
  config: Record<string, unknown>;
  span?: number;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface Agent {
  name: string;
  role: string;
  description: string;
  parent: string | null;
  children: string[];
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  source: "framework" | "client";
  description: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface Event {
  id: number;
  run_id: string | null;
  session_id: string | null;
  agent: string;
  type: string;
  subtype: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  parent_event_id: number | null;
  source: string | null;
  target: string | null;
  status: string | null;
  priority: number;
  tags: string[] | null;
  timestamp: string;
  created_at: string;
}

export interface EventRun {
  run_id: string;
  agent: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  event_count: number;
}

// ---------------------------------------------------------------------------
// Jobs / Queue
// ---------------------------------------------------------------------------

export interface Job {
  id: number;
  job_type: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed";
  priority: number;
  agent: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  retries: number;
  max_retries: number;
}

export interface QueueStatus {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  recent_jobs: Job[];
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatSession {
  id: string;
  agent: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface BusEvent {
  channel: string;
  event_type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Gateway health
// ---------------------------------------------------------------------------

export interface GatewayHealth {
  status: string;
  engine_running: boolean;
  uptime: number;
  version: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Ops monitoring
// ---------------------------------------------------------------------------

export interface OpsAlert {
  id: number;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
  auto_healed: boolean;
  acknowledged: boolean;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface OpsHealthSnapshot {
  engine_running: boolean;
  worker_count: number;
  workers_alive: number;
  pending_jobs: number;
  failed_jobs_last_hour: number;
  stale_locks: number;
  db_ok: boolean;
  snapshot_at: string | null;
}

// ---------------------------------------------------------------------------
// Event filter params
// ---------------------------------------------------------------------------

export interface EventFilters {
  agent?: string;
  type?: string;
  subtype?: string;
  run_id?: string;
  session_id?: string;
  status?: string;
  since?: string;
  limit?: number;
  offset?: number;
}
