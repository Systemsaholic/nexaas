"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, Check, X, Pencil } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  proposedCode?: string;
  status?: "pending" | "applied" | "discarded";
}

interface CopilotProps {
  skillId?: string;
  activeFile?: string;
  fileContent?: string;
  onApplyCode?: (code: string) => void;
}

function extractFileContent(text: string): string | null {
  const match = text.match(/```(?:yaml|hbs|handlebars|typescript|ts|markdown|md)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function extractExplanation(text: string): string {
  const beforeCode = text.split(/```/)[0].trim();
  return beforeCode || "Proposed changes:";
}

export function SkillCopilot({ skillId, activeFile, fileContent, onApplyCode }: CopilotProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function sendMessage(overrideMsg?: string) {
    const userMsg = (overrideMsg || input).trim();
    if (!userMsg || loading) return;

    if (!overrideMsg) setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const res = await fetch("/api/v1/skills/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMsg,
          skillId,
          activeFile,
          fileContent,
        }),
      });
      const json = await res.json();

      if (json.ok) {
        const text = json.data.response;
        const proposedCode = extractFileContent(text);
        const explanation = extractExplanation(text);

        setMessages((prev) => [...prev, {
          role: "assistant",
          content: explanation,
          proposedCode: proposedCode ?? undefined,
          status: proposedCode ? "pending" : undefined,
        }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${json.error}` }]);
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  }

  function handleApply(msgIndex: number) {
    const msg = messages[msgIndex];
    if (!msg.proposedCode || !onApplyCode) return;

    onApplyCode(msg.proposedCode);
    setMessages((prev) => prev.map((m, i) =>
      i === msgIndex ? { ...m, status: "applied" as const } : m
    ));
  }

  function handleDiscard(msgIndex: number) {
    setMessages((prev) => prev.map((m, i) =>
      i === msgIndex ? { ...m, status: "discarded" as const } : m
    ));
  }

  function handleKeepEditing() {
    setInput("Also: ");
  }

  return (
    <div className="flex flex-col h-full border rounded-md bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 text-purple-500" />
        <span className="text-sm font-medium">Skill Copilot</span>
        {activeFile && <span className="text-xs text-zinc-400 ml-auto">{activeFile}</span>}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-3" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="text-center text-zinc-400 text-xs py-8 space-y-2">
            <p>I edit your skill files directly.</p>
            <p className="text-zinc-500">Try:</p>
            <p>"Add an approval gate for payments over $500"</p>
            <p>"Add a notify_mode question to onboarding"</p>
            <p>"Make the prompt handle multi-language emails"</p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "user" ? (
                <div className="text-right">
                  <div className="inline-block rounded-lg bg-zinc-900 text-white px-3 py-2 max-w-[90%] text-left text-sm dark:bg-zinc-100 dark:text-zinc-900">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{msg.content}</p>

                  {msg.proposedCode && (
                    <div className={`rounded-md border overflow-hidden ${
                      msg.status === "applied" ? "border-green-300 dark:border-green-800" :
                      msg.status === "discarded" ? "border-zinc-200 opacity-40 dark:border-zinc-800" :
                      "border-purple-300 dark:border-purple-800"
                    }`}>
                      {/* Action bar */}
                      <div className={`flex items-center justify-between px-3 py-1.5 ${
                        msg.status === "applied" ? "bg-green-50 dark:bg-green-950" :
                        msg.status === "discarded" ? "bg-zinc-50 dark:bg-zinc-900" :
                        "bg-purple-50 dark:bg-purple-950"
                      }`}>
                        <span className="text-xs font-medium">
                          {msg.status === "applied" ? "Applied" :
                           msg.status === "discarded" ? "Discarded" :
                           `Proposed edit → ${activeFile}`}
                        </span>

                        {msg.status === "pending" && (
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-green-700 hover:bg-green-100 dark:text-green-400" onClick={() => handleApply(i)}>
                              <Check className="h-3 w-3 mr-1" /> Apply
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-zinc-500 hover:bg-zinc-100" onClick={handleKeepEditing}>
                              <Pencil className="h-3 w-3 mr-1" /> Edit more
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-red-500 hover:bg-red-50" onClick={() => handleDiscard(i)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* Code preview (collapsed if discarded) */}
                      {msg.status !== "discarded" && (
                        <pre className="p-3 text-xs text-zinc-200 font-mono overflow-x-auto max-h-52 overflow-y-auto bg-zinc-900">
                          {msg.proposedCode.length > 2000
                            ? msg.proposedCode.slice(0, 2000) + `\n\n... (${msg.proposedCode.length} total chars)`
                            : msg.proposedCode}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <div className="h-2 w-2 rounded-full bg-purple-500 animate-pulse" />
              Generating edit...
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t p-2">
        <form onSubmit={(e) => { e.preventDefault(); sendMessage(); }} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe the change..."
            className="flex-1 rounded-md border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
            disabled={loading}
          />
          <Button type="submit" size="sm" disabled={!input.trim() || loading} className="bg-purple-600 hover:bg-purple-700">
            <Send className="h-3 w-3" />
          </Button>
        </form>
      </div>
    </div>
  );
}
