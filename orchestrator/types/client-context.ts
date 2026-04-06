/**
 * ClientContext — the complete runtime context assembled by CAG.
 *
 * Architecture Guide v4 §8.2
 *
 * Three levels:
 * - Level 1 (Central): tenant, billing, licensed skills
 * - Level 2 (Workspace): identity docs, profile, contracts, channels
 * - Level 3 (Skill): SOP, runbook, workflow state, live data, input
 */

// ── Level 1 — Central ──────────────────────────────────────────────────

export interface CentralContext {
  tenantId: string;
  billingTier: "trial" | "starter" | "pro" | "enterprise";
  licensedSkills: string[];
}

// ── Level 2 — Workspace ─────────────────────────────────────────────────

export interface ApprovalGates {
  replyExternal?: "auto_execute" | "notify_after" | "required" | "always_manual";
  replyKnown?: "auto_execute" | "notify_after" | "required";
  payment?: "required" | "always_manual";
  delete?: "always_manual";
  [key: string]: string | undefined;
}

export interface EscalationRules {
  financial?: string;  // email address
  complaints?: string;
  legal?: string;
  [key: string]: string | undefined;
}

export interface NotificationPrefs {
  channel: string;
  mode: "digest_urgent_only" | "notify_all" | "daily_digest";
}

export interface UserChannelPreferences {
  [userEmail: string]: {
    approval?: string;    // channel_id
    briefing?: string;
    urgent?: string;
    digest?: string;
  };
}

export interface WorkspaceContext {
  clientName: string;
  timezone: string;
  domain: string;

  // Agent Identity documents (full prose)
  brandVoice: string;
  deptOperations: string;
  agentHandbook: string;

  // Behavioral contract (structured)
  connectedTools: string[];
  approvalGates: ApprovalGates;
  escalationRules: EscalationRules;
  hardLimits: string[];
  notificationPrefs: NotificationPrefs;
  userPreferences: UserChannelPreferences;
}

// ── Level 3 — Skill Runtime ─────────────────────────────────────────────

export interface WorkflowState {
  threadId?: string;
  workflowStage?: string;
  priorDisposition?: string;
  priorActions?: Array<{ date: string; action: string; summary: string }>;
  retryCount?: number;
  approvalPending?: boolean;
}

export interface ResolvedChannel {
  channelId: string;
  displayName: string;
  direction: "one-way" | "two-way";
  capabilities: string[];
  implementation: Record<string, unknown>;
}

export interface ResolvedChannels {
  approval?: ResolvedChannel;
  notification?: ResolvedChannel;
  escalation?: ResolvedChannel;
  digest?: ResolvedChannel;
}

export interface RagChunk {
  content: string;
  source: string;
  relevance?: number;
}

export interface SkillContext {
  skillSop: string;
  clientRunbook: string | null;
  workflowState: WorkflowState;
  liveData: Record<string, unknown>;
  resolvedChannels: ResolvedChannels;
  customRules: string | null;
  ragChunks: RagChunk[];
}

// ── Complete ClientContext ───────────────────────────────────────────────

export interface ClientContext extends CentralContext, WorkspaceContext, SkillContext {
  // Input data for this specific execution
  input: Record<string, unknown>;
}
