import { loadMcpRegistry } from "@/lib/integrations";
import { ok, err } from "@/lib/api-response";

export async function GET() {
  try {
    const servers = await loadMcpRegistry();
    return ok(servers);
  } catch (e) {
    return err(`Failed to load MCP registry: ${(e as Error).message}`, 500);
  }
}
