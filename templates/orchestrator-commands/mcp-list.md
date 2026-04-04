List all MCP server integrations in the registry.

1. Read the registry: `cat /opt/nexaas/mcp/_registry.yaml`
2. For each server, check if a config exists: `ls /opt/nexaas/mcp/configs/`
3. Present a clean table: ID, name, port, capabilities, required env vars, config status
4. Note any servers that have configs but aren't in the registry (orphaned)
5. Note any registry entries that don't have config files (missing configs)
