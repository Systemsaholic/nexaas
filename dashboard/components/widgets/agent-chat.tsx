"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { renderMarkdown } from "@/lib/sanitize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import {
  PlusIcon,
  MessageSquareIcon,
  Trash2Icon,
  ChevronDownIcon,
  PencilIcon,
  CheckIcon,
} from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatSession {
  id: string;
  agent: string;
  label: string;
  autoLabeled: boolean; // false once user manually renames
  messages: Message[];
  createdAt: Date;
}

interface AgentChatConfig {
  default_agent?: string;
  show_tool_calls?: boolean;
  [key: string]: unknown;
}

let chatCounter = 0;
function makeSessionId() {
  return `session-${Date.now()}-${++chatCounter}`;
}

/**
 * Generate a short contextual title from conversation messages.
 * Looks at the first user message and first assistant response to
 * infer the overarching topic.
 */
function generateChatTitle(messages: Message[]): string {
  const userMsgs = messages.filter((m) => m.role === "user");
  const assistantMsgs = messages.filter((m) => m.role === "assistant");

  if (userMsgs.length === 0) return "New Chat";

  const firstUser = userMsgs[0].content.trim();
  const firstAssistant = assistantMsgs[0]?.content.trim() ?? "";

  // Try to extract a topic from the assistant's response — look for a markdown heading
  const headingMatch = firstAssistant.match(/^#+\s+(.+)$/m);
  if (headingMatch) {
    const heading = headingMatch[1].replace(/\*+/g, "").trim();
    if (heading.length > 3 && heading.length <= 50) return heading;
  }

  // Extract key nouns/phrases from the user's first message
  // Remove common filler words to get the core topic
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "i", "me",
    "my", "we", "our", "you", "your", "it", "its", "they", "them", "their",
    "this", "that", "these", "those", "what", "which", "who", "whom",
    "how", "when", "where", "why", "if", "then", "so", "but", "and", "or",
    "not", "no", "to", "of", "in", "on", "at", "by", "for", "with",
    "about", "from", "as", "into", "through", "during", "before", "after",
    "please", "help", "want", "like", "just", "get", "make", "give", "tell",
  ]);

  const words = firstUser
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));

  if (words.length === 0) {
    // Fallback: use truncated first message
    return firstUser.slice(0, 40) + (firstUser.length > 40 ? "…" : "");
  }

  // Take the first few meaningful words and title-case them
  const topic = words
    .slice(0, 5)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  return topic.length > 45 ? topic.slice(0, 42) + "…" : topic;
}

export default function AgentChat({
  config,
  title,
}: {
  config: AgentChatConfig;
  title?: string;
}) {
  const defaultAgent = config.default_agent ?? "assistant";

  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const initial: ChatSession = {
      id: makeSessionId(),
      agent: defaultAgent,
      label: "New Chat",
      autoLabeled: true,
      messages: [],
      createdAt: new Date(),
    };
    return [initial];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessions[0].id
  );

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [wsStatus, setWsStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [editingLabelValue, setEditingLabelValue] = useState("");
  const editingLabelIdRef = useRef<string | null>(null);
  const editingLabelValueRef = useRef("");
  const commitPendingRef = useRef(false);
  const labelInputRef = useRef<HTMLInputElement>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const serverSessionIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const gateways = useWorkspaceStore((s) => s.gateways);

  const connectWs = useCallback(() => {
    if (!activeWorkspaceId) return;
    const gwConfig = gateways.get(activeWorkspaceId);
    if (!gwConfig) return;

    setWsStatus("connecting");
    const wsBase = gwConfig.url.replace(/^http/, "ws");
    const ws = new WebSocket(
      `${wsBase}/api/chat`,
      [`token.${gwConfig.apiKey}`]
    );

    ws.onopen = () => setWsStatus("connected");

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.session_id) serverSessionIdRef.current = data.session_id;

        if (data.type === "chunk") {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId) return s;
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = {
                  role: "assistant",
                  content: last.content + data.content,
                };
              } else {
                msgs.push({ role: "assistant", content: data.content });
              }
              return { ...s, messages: msgs };
            })
          );
        } else if (data.type === "done") {
          setStreaming(false);
          // Auto-generate title after first assistant response completes
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId || !s.autoLabeled) return s;
              if (s.messages.some((m) => m.role === "assistant")) {
                return { ...s, label: generateChatTitle(s.messages) };
              }
              return s;
            })
          );
        } else if (data.type === "error") {
          setStreaming(false);
          setSessions((prev) =>
            prev.map((s) =>
              s.id === activeSessionId
                ? {
                    ...s,
                    messages: [
                      ...s.messages,
                      {
                        role: "assistant" as const,
                        content: `Error: ${data.content}`,
                      },
                    ],
                  }
                : s
            )
          );
        }
      } catch {
        // ignore
      }
    };

    ws.onerror = () => setWsStatus("disconnected");
    ws.onclose = () => setWsStatus("disconnected");

    wsRef.current = ws;
  }, [activeWorkspaceId, gateways, activeSessionId]);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, [connectWs]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages]);

  // Focus label input when editing starts
  useEffect(() => {
    if (editingLabelId) {
      labelInputRef.current?.focus();
      labelInputRef.current?.select();
    }
  }, [editingLabelId]);

  const send = () => {
    const text = input.trim();
    if (
      !text ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    )
      return;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId
          ? {
              ...s,
              messages: [
                ...s.messages,
                { role: "user" as const, content: text },
              ],
            }
          : s
      )
    );
    setInput("");
    setStreaming(true);

    wsRef.current.send(
      JSON.stringify({
        agent: activeSession.agent,
        message: text,
        session_id: serverSessionIdRef.current,
      })
    );
  };

  const createNewChat = () => {
    const newSession: ChatSession = {
      id: makeSessionId(),
      agent: defaultAgent,
      label: "New Chat",
      autoLabeled: true,
      messages: [],
      createdAt: new Date(),
    };
    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(newSession.id);
    serverSessionIdRef.current = null;
    wsRef.current?.close();
  };

  const deleteSession = (sessionId: string) => {
    if (sessions.length <= 1) return;
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setActiveSessionId(remaining[remaining.length - 1].id);
    }
  };

  const switchSession = (sessionId: string) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    serverSessionIdRef.current = null;
    wsRef.current?.close();
  };

  const startRenaming = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    editingLabelIdRef.current = sessionId;
    editingLabelValueRef.current = session.label;
    setEditingLabelId(sessionId);
    setEditingLabelValue(session.label);
  };

  const commitRename = useCallback(() => {
    if (commitPendingRef.current) return;
    const id = editingLabelIdRef.current;
    const value = editingLabelValueRef.current.trim();
    if (!id) return;
    commitPendingRef.current = true;
    if (value) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, label: value, autoLabeled: false } : s
        )
      );
    }
    editingLabelIdRef.current = null;
    editingLabelValueRef.current = "";
    setEditingLabelId(null);
    setEditingLabelValue("");
    // Reset guard after this event loop tick
    requestAnimationFrame(() => {
      commitPendingRef.current = false;
    });
  }, []);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* Editable title for active session */}
            {editingLabelId === activeSessionId ? (
              <div className="flex items-center gap-1">
                <Input
                  ref={labelInputRef}
                  value={editingLabelValue}
                  onChange={(e) => {
                    setEditingLabelValue(e.target.value);
                    editingLabelValueRef.current = e.target.value;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      editingLabelIdRef.current = null;
                      editingLabelValueRef.current = "";
                      setEditingLabelId(null);
                      setEditingLabelValue("");
                    }
                  }}
                  onBlur={commitRename}
                  className="h-6 text-sm font-medium w-48"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={commitRename}
                >
                  <CheckIcon className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                className="flex items-center gap-1.5 group cursor-pointer min-w-0"
                onClick={() => startRenaming(activeSessionId)}
                title="Click to rename"
              >
                <CardTitle className="text-sm font-medium truncate">
                  {activeSession.label}
                </CardTitle>
                <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
            <Badge
              variant={wsStatus === "connected" ? "default" : "secondary"}
              className="text-[10px] px-1.5 py-0 shrink-0"
            >
              {wsStatus}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1 text-xs h-7 px-2"
                >
                  <MessageSquareIcon className="size-3" />
                  {sessions.length}
                  <ChevronDownIcon className="size-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {sessions.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    className="flex items-center justify-between gap-2"
                    onClick={() => switchSession(s.id)}
                  >
                    <span
                      className={`truncate text-xs ${
                        s.id === activeSessionId ? "font-semibold" : ""
                      }`}
                    >
                      {s.label}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge
                        variant="outline"
                        className="text-[9px] px-1 py-0"
                      >
                        {s.messages.length}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRenaming(s.id);
                        }}
                      >
                        <PencilIcon className="size-3 text-muted-foreground" />
                      </Button>
                      {sessions.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(s.id);
                          }}
                        >
                          <Trash2Icon className="size-3 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={createNewChat}>
                  <PlusIcon className="mr-2 size-3.5" />
                  New Chat
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={createNewChat}
              title="New Chat"
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 p-0">
        <ScrollArea className="flex-1 px-4">
          <div className="flex min-h-[350px] flex-col gap-2 py-2">
            {activeSession.messages.length === 0 && (
              <p className="text-sm text-muted-foreground text-center mt-auto mb-auto">
                No messages yet. Start a conversation with{" "}
                {activeSession.agent}.
              </p>
            )}
            {activeSession.messages.map((msg, i) => (
              <div
                key={i}
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground whitespace-pre-wrap"
                    : "mr-auto bg-muted prose prose-sm dark:prose-invert max-w-none"
                }`}
              >
                {msg.role === "user" ? (
                  msg.content
                ) : (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(msg.content),
                    }}
                  />
                )}
              </div>
            ))}
            {streaming && (
              <div className="mr-auto text-xs text-muted-foreground animate-pulse">
                {activeSession.agent} is typing...
              </div>
            )}
            <div ref={scrollRef} />
          </div>
        </ScrollArea>
        <div className="flex items-center gap-2 border-t px-4 py-3">
          <Input
            placeholder={`Message ${activeSession.agent}...`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="flex-1"
            disabled={wsStatus !== "connected"}
          />
          <Button
            size="sm"
            disabled={
              !input.trim() || streaming || wsStatus !== "connected"
            }
            onClick={send}
          >
            Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
