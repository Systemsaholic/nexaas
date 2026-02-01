"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

interface AgentNode {
  name: string;
  role: string;
  description: string;
  children: AgentNode[];
}

interface AgentTreeConfig {
  show_sub_agents?: boolean;
  [key: string]: unknown;
}

function TreeNode({ node, depth }: { node: AgentNode; depth: number }) {
  return (
    <div style={{ paddingLeft: depth * 20 }}>
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        <span className="text-sm font-medium">{node.name}</span>
        <span className="text-xs text-muted-foreground">{node.role}</span>
        <Badge variant="secondary" className="ml-auto text-[10px] bg-emerald-500/15 text-emerald-700">
          active
        </Badge>
      </div>
      {node.children?.map((child) => (
        <TreeNode key={child.name} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function agentToNode(agent: { name: string; config: { name: string; role: string; description: string }; children: unknown[] }): AgentNode {
  return {
    name: agent.config?.name ?? agent.name,
    role: agent.config?.role ?? "",
    description: agent.config?.description ?? "",
    children: (agent.children ?? []).map((c) => agentToNode(c as typeof agent)),
  };
}

export default function AgentTree({
  config,
  title,
}: {
  config: AgentTreeConfig;
  title?: string;
}) {
  const agents = useWorkspaceStore((s) => s.agents);
  const showSub = config.show_sub_agents !== false;

  // agents from store are already the full tree from /api/agents
  const tree: AgentNode[] = (agents as unknown[]).map((a) =>
    agentToNode(a as Parameters<typeof agentToNode>[0])
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Agent Tree"}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px] px-4 pb-4">
          {tree.map((node) => (
            <TreeNode
              key={node.name}
              node={showSub ? node : { ...node, children: [] }}
              depth={0}
            />
          ))}
          {tree.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">No agents found.</p>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
