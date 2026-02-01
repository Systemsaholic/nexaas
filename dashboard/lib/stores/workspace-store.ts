import { create } from "zustand";
import { GatewayClient } from "../gateway-client";
import type { Agent, Workspace } from "../types";

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
  connectionStatus: ConnectionStatus;

  // Actions
  addGateway: (id: string, config: GatewayConfig) => void;
  removeGateway: (id: string) => void;
  setActiveWorkspace: (id: string) => Promise<void>;
  setActivePerspective: (perspectiveId: string) => void;

  // Helpers
  getActiveGatewayClient: () => GatewayClient | null;
}

// ---------------------------------------------------------------------------
// Client cache – avoids recreating clients on every access
// ---------------------------------------------------------------------------

const clientCache = new Map<string, GatewayClient>();

function getOrCreateClient(config: GatewayConfig): GatewayClient {
  const key = `${config.url}::${config.apiKey}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new GatewayClient(config.url, config.apiKey);
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
              connectionStatus: "disconnected" as const,
            }
          : {}),
      };
    });
  },

  async setActiveWorkspace(id) {
    const config = get().gateways.get(id);
    if (!config) return;

    set({ activeWorkspaceId: id, connectionStatus: "connecting", workspace: null, agents: [] });

    try {
      const client = getOrCreateClient(config);
      const [workspace, agents] = await Promise.all([
        client.getWorkspace(),
        client.getAgents(),
      ]);

      const defaultPerspective = workspace.perspectives[0]?.id ?? null;

      set({
        workspace,
        agents,
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

  getActiveGatewayClient() {
    const { activeWorkspaceId, gateways } = get();
    if (!activeWorkspaceId) return null;
    const config = gateways.get(activeWorkspaceId);
    if (!config) return null;
    return getOrCreateClient(config);
  },
}));
