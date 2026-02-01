"use client";

import { useState } from "react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import type { Skill } from "@/lib/types";

export default function SkillsList() {
  const skills = useWorkspaceStore((s) => s.skills);
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [executing, setExecuting] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleExecute = async (skill: Skill) => {
    if (!client) return;
    setExecuting(skill.filename);
    setResult(null);
    try {
      const res = await client.executeSkill(skill.filename.replace(/\.md$/, ""));
      setResult(res.result);
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExecuting(null);
    }
  };

  if (!skills.length) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No skills discovered.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {skills.map((skill) => (
        <div
          key={skill.filename}
          className="flex items-center justify-between rounded-md border p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{skill.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {skill.source}
              </span>
            </div>
            {skill.description && (
              <p className="mt-0.5 text-xs text-muted-foreground truncate">
                {skill.description}
              </p>
            )}
          </div>
          <button
            className="ml-3 shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            disabled={executing === skill.filename}
            onClick={() => handleExecute(skill)}
          >
            {executing === skill.filename ? "Running..." : "Execute"}
          </button>
        </div>
      ))}
      {result && (
        <div className="mt-3 rounded-md border bg-muted p-3">
          <p className="text-xs font-medium mb-1">Result:</p>
          <pre className="text-xs whitespace-pre-wrap">{result}</pre>
        </div>
      )}
    </div>
  );
}
