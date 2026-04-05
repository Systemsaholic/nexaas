export interface ClientUser {
  id: string;
  email: string;
  username: string;
  role: string;
  company_id: string;
  totp_enabled: boolean;
  last_login: string | null;
}

export interface IntegrationConnection {
  id: number;
  workspace_id: string;
  provider: string;
  status: "pending" | "connected" | "error" | "revoked";
  scopes: string[] | null;
  metadata: Record<string, unknown>;
  connected_at: string | null;
  error_message: string | null;
}

export interface PendingApproval {
  id: number;
  workspace_id: string;
  skill_id: string | null;
  action_type: string;
  summary: string;
  details: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  responded_at: string | null;
  expires_at: string | null;
}

export interface ActivityEntry {
  id: number;
  workspace_id: string;
  skill_id: string | null;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  tag_route: string | null;
  created_at: string;
}
