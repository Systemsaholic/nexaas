"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, Copy, Check } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface CopilotProps {
  skillId?: string;
  activeFile?: string;
  fileContent?: string;
  onApplyCode?: (code: string) => void;
}

export function SkillCopilot({ skillId, activeFile, fileContent, onApplyCode }: CopilotProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMsg = input.trim();
    setInput("");
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
        setMessages((prev) => [...prev, { role: "assistant", content: json.data.response }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${json.error}` }]);
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  }

  function extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const regex = /```(?:yaml|hbs|handlebars|typescript|ts)?\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push(match[1].trim());
    }
    return blocks;
  }

  function copyToClipboard(text: string, idx: number) {
    navigator.clipboard.writeText(text);
    setCopied(idx);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="flex flex-col h-full border rounded-md bg-white dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 text-purple-500" />
        <span className="text-sm font-medium">Skill Copilot</span>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-3" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="text-center text-zinc-400 text-xs py-8 space-y-2">
            <p>Ask me to generate or improve skill files.</p>
            <p className="text-zinc-500">Examples:</p>
            <p>"Create a contract for an invoice reminder skill"</p>
            <p>"Add a folder_sort option to the onboarding questions"</p>
            <p>"Write TAG routes for an appointment booking skill"</p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map((msg, i) => (
            <div key={i} className={`text-sm ${msg.role === "user" ? "text-right" : ""}`}>
              {msg.role === "user" ? (
                <div className="inline-block rounded-lg bg-zinc-900 text-white px-3 py-2 max-w-[90%] text-left dark:bg-zinc-100 dark:text-zinc-900">
                  {msg.content}
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Render text with code blocks */}
                  {msg.content.split(/(```[\s\S]*?```)/g).map((part, j) => {
                    if (part.startsWith("```")) {
                      const code = part.replace(/```(?:yaml|hbs|handlebars|typescript|ts)?\n/, "").replace(/```$/, "").trim();
                      return (
                        <div key={j} className="relative group">
                          <pre className="rounded-md bg-zinc-950 p-3 text-xs text-zinc-300 font-mono overflow-x-auto dark:bg-zinc-900">
                            {code}
                          </pre>
                          <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                              onClick={() => copyToClipboard(code, i * 100 + j)}
                            >
                              {copied === i * 100 + j ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            </Button>
                            {onApplyCode && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs bg-purple-800 text-purple-200 hover:bg-purple-700"
                                onClick={() => onApplyCode(code)}
                              >
                                Apply
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return part.trim() ? (
                      <p key={j} className="text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{part.trim()}</p>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <div className="h-2 w-2 rounded-full bg-purple-500 animate-pulse" />
              Thinking...
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t p-2">
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the copilot..."
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
