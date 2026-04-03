/**
 * Workspace session bootstrap.
 *
 * Every Trigger task that needs workspace context calls createWorkspaceSession()
 * before doing anything else. Returns resolved workspace root, MCP servers,
 * and manifest — everything runClaude() needs.
 */

import { loadManifest, type WorkspaceManifest } from "./manifest-loader.js";
import { resolveMcpServers } from "./mcp-injector.js";

export interface WorkspaceSession {
  workspaceId: string;
  workspaceRoot: string;
  mcpServers: string[];
  manifest: WorkspaceManifest;
}

export async function createWorkspaceSession(
  workspaceId: string,
  options?: { skillId?: string; threadId?: string }
): Promise<WorkspaceSession> {
  const manifest = await loadManifest(workspaceId);
  const mcpServers = resolveMcpServers(manifest, options?.skillId);

  return {
    workspaceId,
    workspaceRoot: manifest.workspaceRoot,
    mcpServers,
    manifest,
  };
}

export { loadManifest, type WorkspaceManifest } from "./manifest-loader.js";
export { resolveMcpServers } from "./mcp-injector.js";
