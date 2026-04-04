import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export interface McpServer {
  id: string;
  name: string;
  defaultPort: number;
  capabilities: string[];
  requiredEnv: string[];
  description?: string;
  [key: string]: unknown;
}

export interface McpRegistry {
  version: string;
  servers: McpServer[];
}

export async function loadMcpRegistry(): Promise<McpServer[]> {
  const raw = await readFile(join(NEXAAS_ROOT, "mcp", "_registry.yaml"), "utf-8");
  const registry = YAML.load(raw) as McpRegistry;
  return registry.servers ?? [];
}

export async function getMcpServerConfig(serverId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(NEXAAS_ROOT, "mcp", "configs", `${serverId}.yaml`), "utf-8");
    return YAML.load(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
