import { create } from "zustand";
import type { OpsAlert, OpsHealthSnapshot } from "../types";
import { useWorkspaceStore } from "./workspace-store";

interface OpsState {
  health: OpsHealthSnapshot | null;
  alerts: OpsAlert[];
  loading: boolean;
  error: string | null;
  unacknowledgedCriticalCount: number;

  fetchHealth: () => Promise<void>;
  fetchAlerts: (limit?: number, severity?: string) => Promise<void>;
  acknowledge: (id: number) => Promise<void>;
  heal: (action: string) => Promise<string>;
  pushAlert: (alert: OpsAlert) => void;
}

export const useOpsStore = create<OpsState>()((set, get) => ({
  health: null,
  alerts: [],
  loading: false,
  error: null,
  unacknowledgedCriticalCount: 0,

  async fetchHealth() {
    const client = useWorkspaceStore.getState().getActiveEngineClient();
    if (!client) return;
    try {
      const health = await client.getOpsHealth();
      set({ health });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  async fetchAlerts(limit?: number, severity?: string) {
    const client = useWorkspaceStore.getState().getActiveEngineClient();
    if (!client) return;
    set({ loading: true, error: null });
    try {
      const alerts = await client.getOpsAlerts(limit, severity);
      const unacknowledgedCriticalCount = alerts.filter(
        (a) => a.severity === "critical" && !a.acknowledged,
      ).length;
      set({ alerts, loading: false, unacknowledgedCriticalCount });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  async acknowledge(id: number) {
    const client = useWorkspaceStore.getState().getActiveEngineClient();
    if (!client) return;
    try {
      await client.acknowledgeAlert(id);
      set((state) => {
        const alerts = state.alerts.map((a) =>
          a.id === id ? { ...a, acknowledged: true } : a,
        );
        const unacknowledgedCriticalCount = alerts.filter(
          (a) => a.severity === "critical" && !a.acknowledged,
        ).length;
        return { alerts, unacknowledgedCriticalCount };
      });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  async heal(action: string) {
    const client = useWorkspaceStore.getState().getActiveEngineClient();
    if (!client) throw new Error("No gateway client");
    const res = await client.triggerHeal(action);
    return res.result;
  },

  pushAlert(alert: OpsAlert) {
    set((state) => {
      const alerts = [alert, ...state.alerts].slice(0, 200);
      const unacknowledgedCriticalCount = alerts.filter(
        (a) => a.severity === "critical" && !a.acknowledged,
      ).length;
      return { alerts, unacknowledgedCriticalCount };
    });
  },
}));
