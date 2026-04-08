export interface WorkspaceManifest {
  id: string;
  name: string;
  workspaceRoot: string;
  skills: string[];
  agents: string[];
  mcp: Record<string, string>;
  capabilities: Record<string, boolean>;
  trigger: { projectId: string; workerUrl: string };
  network: { privateIp: string; publicIp: string };
  ssh: { host: string; user: string; port: number };
  context: { threadTtlDays: number; maxTurnsBeforeSummary: number };
}

export interface HealthSnapshot {
  id: number;
  workspace_id: string;
  ram_used_mb: number;
  ram_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  container_count: number;
  containers_healthy: number;
  worker_active: boolean;
  vps_ip: string;
  snapshot_at: string;
}

export interface MemorySnapshot {
  id: number;
  workspace_id: string;
  event_count: number;
  entity_count: number;
  active_fact_count: number;
  relation_count: number;
  active_journal_entries: number;
  embedding_lag: number;
  events_24h: number;
  event_type_breakdown: Record<string, number>;
  oldest_event: string | null;
  newest_event: string | null;
  snapshot_at: string;
}

export interface Instance {
  id: string;
  name: string;
  privateIp: string;
  publicIp: string;
  health: HealthSnapshot | null;
  manifest: WorkspaceManifest;
}

export interface ContainerStatus {
  name: string;
  status: string;
  health: string;
}

export interface DeployRun {
  id: number;
  workspace_id: string;
  vps_ip: string;
  admin_email: string;
  trigger_run_id: string | null;
  status: "pending" | "running" | "completed" | "failed";
  current_step: number;
  steps: DeployStep[];
  log_output: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  ovh_instance_id: string | null;
  public_ip: string | null;
  private_ip: string | null;
  vps_flavor: string | null;
  deploy_mode: "new_vps" | "existing";
}

export interface DeployStep {
  step: number;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at?: string;
  completed_at?: string;
}

export interface SkillProposal {
  id: number;
  skill_id: string;
  workspace_id: string;
  from_version: string;
  proposed_version: string;
  proposed_improvement: string;
  status: "pending" | "reviewed" | "deployed" | "rejected" | "expired";
  pass1_clean: boolean | null;
  pass2_clean: boolean | null;
  violations: unknown[] | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface FeedbackSignal {
  id: number;
  skill_id: string;
  workspace_id: string;
  signal: string;
  claude_reflection: string | null;
  created_at: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
