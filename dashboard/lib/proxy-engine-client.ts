import type {
  Agent,
  Event,
  EventFilters,
  GatewayHealth,
  OpsAlert,
  OpsHealthSnapshot,
  QueueStatus,
  RegistryEntry,
  Skill,
  Workspace,
} from "./types";

export class ProxyEngineClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ProxyEngineClientError";
  }
}

/**
 * Engine client that routes all requests through the server-side proxy.
 * This avoids direct browser-to-engine calls which fail when the browser
 * cannot reach the engine directly (different networks, firewalls, NAT).
 */
export class ProxyEngineClient {
  private async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch("/api/engine/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        path,
        method: init?.method ?? "GET",
        body: init?.body,
      }),
    });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }
      throw new ProxyEngineClientError(
        `Engine request failed: ${res.status} ${res.statusText}`,
        res.status,
        body,
      );
    }

    return res.json() as Promise<T>;
  }

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  async getHealth(): Promise<GatewayHealth> {
    return this.request<GatewayHealth>("/health");
  }

  // -----------------------------------------------------------------------
  // Workspace
  // -----------------------------------------------------------------------

  async getWorkspace(): Promise<Workspace> {
    const res = await this.request<{ root: string; config: Workspace }>("/workspace");
    return res.config;
  }

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------

  async getAgents(): Promise<Agent[]> {
    return this.request<Agent[]>("/agents");
  }

  async getAgent(name: string): Promise<Agent> {
    return this.request<Agent>(`/agents/${encodeURIComponent(name)}`);
  }

  // -----------------------------------------------------------------------
  // Registries
  // -----------------------------------------------------------------------

  async getRegistries(): Promise<string[]> {
    return this.request<string[]>("/registries");
  }

  async getRegistry(name: string): Promise<RegistryEntry[]> {
    return this.request<RegistryEntry[]>(`/registries/${encodeURIComponent(name)}`);
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  async getEvents(filters?: EventFilters): Promise<Event[]> {
    const params = new URLSearchParams();
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value));
        }
      }
    }
    const qs = params.toString();
    return this.request<Event[]>(`/events${qs ? `?${qs}` : ""}`);
  }

  async createEvent(event: Partial<Event>): Promise<Event> {
    return this.request<Event>("/events", {
      method: "POST",
      body: event,
    });
  }

  // -----------------------------------------------------------------------
  // Queue
  // -----------------------------------------------------------------------

  async getQueueStatus(): Promise<QueueStatus> {
    return this.request<QueueStatus>("/queue");
  }

  // -----------------------------------------------------------------------
  // Usage
  // -----------------------------------------------------------------------

  async getUsage(): Promise<unknown> {
    return this.request<unknown>("/usage");
  }

  // -----------------------------------------------------------------------
  // Ops
  // -----------------------------------------------------------------------

  async getOpsHealth(): Promise<OpsHealthSnapshot> {
    return this.request<OpsHealthSnapshot>("/ops/health");
  }

  async getOpsAlerts(limit?: number, severity?: string): Promise<OpsAlert[]> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (severity) params.set("severity", severity);
    const qs = params.toString();
    return this.request<OpsAlert[]>(`/ops/alerts${qs ? `?${qs}` : ""}`);
  }

  async acknowledgeAlert(id: number): Promise<void> {
    await this.request<{ ok: boolean }>(`/ops/alerts/${id}/acknowledge`, {
      method: "POST",
    });
  }

  async triggerHeal(action: string): Promise<{ action: string; result: string }> {
    return this.request<{ action: string; result: string }>(`/ops/heal/${encodeURIComponent(action)}`, {
      method: "POST",
    });
  }

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------

  async getSkills(): Promise<Skill[]> {
    return this.request<Skill[]>("/skills");
  }

  async executeSkill(name: string): Promise<{ skill: string; result: string }> {
    return this.request<{ skill: string; result: string }>(
      `/skills/${encodeURIComponent(name)}/execute`,
      { method: "POST" },
    );
  }
}
