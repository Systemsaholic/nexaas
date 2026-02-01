import { create } from "zustand";
import { EngineClient } from "../engine-client";
import type { Agent, Skill, Workspace } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  url: string;
  apiKey: string;
  name: string;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface WorkspaceState {
  gateways: Map<string, GatewayConfig>;
  activeWorkspaceId: string | null;
  workspace: Workspace | null;
  activePerspectiveId: string | null;
  agents: Agent[];
  skills: Skill[];
  connectionStatus: ConnectionStatus;

  // Actions
  addGateway: (id: string, config: GatewayConfig) => void;
  removeGateway: (id: string) => void;
  setActiveWorkspace: (id: string) => Promise<void>;
  setActivePerspective: (perspectiveId: string) => void;

  // Helpers
  getActiveEngineClient: () => EngineClient | null;
}

// ---------------------------------------------------------------------------
// Client cache – avoids recreating clients on every access
// ---------------------------------------------------------------------------

const clientCache = new Map<string, EngineClient>();

function getOrCreateClient(config: GatewayConfig): EngineClient {
  const key = `${config.url}::${config.apiKey}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new EngineClient(config.url, config.apiKey);
    clientCache.set(key, client);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  gateways: new Map<string, GatewayConfig>(),
  activeWorkspaceId: null,
  workspace: null,
  activePerspectiveId: null,
  agents: [],
  skills: [],
  connectionStatus: "disconnected",

  addGateway(id, config) {
    set((state) => {
      const next = new Map(state.gateways);
      next.set(id, config);
      return { gateways: next };
    });
  },

  removeGateway(id) {
    set((state) => {
      const next = new Map(state.gateways);
      next.delete(id);
      clientCache.delete(`${state.gateways.get(id)?.url}::${state.gateways.get(id)?.apiKey}`);
      const isActive = state.activeWorkspaceId === id;
      return {
        gateways: next,
        ...(isActive
          ? {
              activeWorkspaceId: null,
              workspace: null,
              activePerspectiveId: null,
              agents: [],
              skills: [],
              connectionStatus: "disconnected" as const,
            }
          : {}),
      };
    });
  },

  async setActiveWorkspace(id) {
    const config = get().gateways.get(id);
    if (!config) return;

    set({ activeWorkspaceId: id, connectionStatus: "connecting", workspace: null, agents: [], skills: [] });

    try {
      const client = getOrCreateClient(config);
      const [workspace, agents, skills] = await Promise.all([
        client.getWorkspace(),
        client.getAgents(),
        client.getSkills().catch(() => [] as Skill[]),
      ]);

      const defaultPerspective = workspace.perspectives[0]?.id ?? null;

      set({
        workspace,
        agents,
        skills,
        activePerspectiveId: defaultPerspective,
        connectionStatus: "connected",
      });
    } catch (err) {
      console.error("Failed to connect to workspace:", err);
      set({ connectionStatus: "error" });
    }
  },

  setActivePerspective(perspectiveId) {
    set({ activePerspectiveId: perspectiveId });
  },

  getActiveEngineClient() {
    const { activeWorkspaceId, gateways } = get();
    if (!activeWorkspaceId) return null;
    const config = gateways.get(activeWorkspaceId);
    if (!config) return null;
    return getOrCreateClient(config);
  },
}));
