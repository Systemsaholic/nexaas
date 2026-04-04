"use client";

import { Terminal } from "@/components/terminal";

export default function TerminalPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Orchestrator Terminal</h1>
      <p className="text-sm text-zinc-500 mb-4">
        Direct shell access to the orchestrator VPS. Use Claude Code or any CLI tool.
      </p>
      <Terminal target="orchestrator" />
    </div>
  );
}
