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

export class EngineClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "EngineClientError";
  }
}

export class EngineClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
    });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => null);
      }
      throw new EngineClientError(
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
      body: JSON.stringify(event),
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

  // -----------------------------------------------------------------------
  // SSE – Event stream (with auth token in URL)
  // -----------------------------------------------------------------------

  subscribeEvents(callback: (event: Event) => void): EventSource {
    const url = `${this.baseUrl}/api/events/stream?token=${encodeURIComponent(this.apiKey)}`;
    const es = new EventSource(url);

    es.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as Event;
        callback(parsed);
      } catch {
        // ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource will auto-reconnect
    };

    return es;
  }

  // -----------------------------------------------------------------------
  // WebSocket – Chat
  // Uses a subprotocol to pass the auth token instead of a query param.
  // The gateway should read the Sec-WebSocket-Protocol header for auth.
  // Falls back to query param if subprotocol auth is not supported.
  // -----------------------------------------------------------------------

  connectChat(
    agent: string,
    onMessage: (msg: { role: string; content: string }) => void,
  ): WebSocket {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    // Pass token via subprotocol header to avoid URL exposure
    const url = `${wsBase}/api/chat`;
    const ws = new WebSocket(url, [`token.${this.apiKey}`]);

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as { role: string; content: string };
        onMessage(data);
      } catch {
        // ignore malformed messages
      }
    };

    return ws;
  }

  /**
   * Create a WebSocket connection URL with auth.
   * Consumers that manage their own WS (e.g. agent-chat widget) should
   * use this instead of constructing URLs with tokens manually.
   */
  getChatWsUrl(): string {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    return `${wsBase}/api/chat`;
  }

  getChatWsProtocols(): string[] {
    return [`token.${this.apiKey}`];
  }
}
