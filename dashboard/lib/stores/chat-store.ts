import { create } from "zustand";
import type { ChatMessage } from "../types";
import { useWorkspaceStore } from "./workspace-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface ChatSessionState {
  agent: string;
  messages: ChatMessage[];
  ws: WebSocket | null;
  status: SessionStatus;
}

interface ChatStoreState {
  sessions: Map<string, ChatSessionState>;

  openChat: (workspaceId: string, agent: string) => string;
  sendMessage: (sessionId: string, content: string) => void;
  closeChat: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: makeId(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatStoreState>()((set, get) => ({
  sessions: new Map<string, ChatSessionState>(),

  openChat(workspaceId: string, agent: string): string {
    const sessionId = makeId();

    // Retrieve the gateway client for the given workspace
    const config = useWorkspaceStore.getState().gateways.get(workspaceId);
    if (!config) {
      set((state) => {
        const next = new Map(state.sessions);
        next.set(sessionId, { agent, messages: [], ws: null, status: "error" });
        return { sessions: next };
      });
      return sessionId;
    }

    // We import EngineClient here to avoid circular dep at module level
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EngineClient } = require("../engine-client") as typeof import("../engine-client");
    const client = new EngineClient(config.url, config.apiKey);

    set((state) => {
      const next = new Map(state.sessions);
      next.set(sessionId, { agent, messages: [], ws: null, status: "connecting" });
      return { sessions: next };
    });

    const ws = client.connectChat(agent, (msg) => {
      set((state) => {
        const next = new Map(state.sessions);
        const session = next.get(sessionId);
        if (!session) return state;
        next.set(sessionId, {
          ...session,
          messages: [...session.messages, makeMessage(msg.role as ChatMessage["role"], msg.content)],
        });
        return { sessions: next };
      });
    });

    ws.onopen = () => {
      set((state) => {
        const next = new Map(state.sessions);
        const session = next.get(sessionId);
        if (!session) return state;
        next.set(sessionId, { ...session, ws, status: "connected" });
        return { sessions: next };
      });
    };

    ws.onerror = () => {
      set((state) => {
        const next = new Map(state.sessions);
        const session = next.get(sessionId);
        if (!session) return state;
        next.set(sessionId, { ...session, status: "error" });
        return { sessions: next };
      });
    };

    ws.onclose = () => {
      set((state) => {
        const next = new Map(state.sessions);
        const session = next.get(sessionId);
        if (!session) return state;
        next.set(sessionId, { ...session, ws: null, status: "disconnected" });
        return { sessions: next };
      });
    };

    // Store the ws reference immediately so closeChat can access it
    set((state) => {
      const next = new Map(state.sessions);
      const session = next.get(sessionId);
      if (session) {
        next.set(sessionId, { ...session, ws });
      }
      return { sessions: next };
    });

    return sessionId;
  },

  sendMessage(sessionId: string, content: string) {
    const session = get().sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    const userMsg = makeMessage("user", content);

    set((state) => {
      const next = new Map(state.sessions);
      const s = next.get(sessionId);
      if (!s) return state;
      next.set(sessionId, { ...s, messages: [...s.messages, userMsg] });
      return { sessions: next };
    });

    session.ws.send(JSON.stringify({ content }));
  },

  closeChat(sessionId: string) {
    const session = get().sessions.get(sessionId);
    if (session?.ws) {
      session.ws.close();
    }
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(sessionId);
      return { sessions: next };
    });
  },
}));
