import { loadMcpRegistry, getMcpServerConfig } from "@/lib/integrations";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const servers = await loadMcpRegistry();
    const server = servers.find((s) => s.id === id);
    if (!server) return notFound("MCP server");

    const config = await getMcpServerConfig(id);

    return ok({ ...server, config });
  } catch (e) {
    return err(`Failed to load MCP server: ${(e as Error).message}`, 500);
  }
}
