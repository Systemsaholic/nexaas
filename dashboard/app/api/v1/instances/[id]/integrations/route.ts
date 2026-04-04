import { loadManifest } from "@/lib/manifests";
import { loadMcpRegistry } from "@/lib/integrations";
import { queryAll } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);
    const allServers = await loadMcpRegistry();

    // Get instance integrations from DB
    const dbIntegrations = await queryAll<{
      server_id: string;
      status: string;
      config: Record<string, unknown>;
      last_checked: string | null;
      error_message: string | null;
    }>(
      `SELECT server_id, status, config, last_checked, error_message
       FROM workspace_integrations WHERE workspace_id = $1`,
      [id]
    );
    const dbMap = new Map(dbIntegrations.map((i) => [i.server_id, i]));

    // MCP servers declared in workspace manifest
    const manifestMcp = Object.keys(manifest.mcp ?? {});

    const integrations = allServers.map((server) => {
      const inManifest = manifestMcp.includes(server.id);
      const dbEntry = dbMap.get(server.id);

      return {
        id: server.id,
        name: server.name,
        capabilities: server.capabilities,
        requiredEnv: server.requiredEnv,
        defaultPort: server.defaultPort,
        enabled: inManifest || !!dbEntry,
        status: dbEntry?.status ?? (inManifest ? "configured" : "not_configured"),
        config: dbEntry?.config ?? (inManifest ? { url: manifest.mcp[server.id] } : null),
        lastChecked: dbEntry?.last_checked ?? null,
        errorMessage: dbEntry?.error_message ?? null,
      };
    });

    return ok(integrations);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Failed to load integrations: ${msg}`, 500);
  }
}
