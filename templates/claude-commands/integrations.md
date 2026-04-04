List and check all MCP integrations on this instance.

1. Read the MCP registry:
   `cat /opt/nexaas/mcp/_registry.yaml`

2. Read the workspace manifest for enabled integrations:
   `cat /opt/nexaas/workspaces/$(grep NEXAAS_WORKSPACE /opt/nexaas/.env | cut -d= -f2).workspace.json | jq '.mcp'`

3. For each enabled MCP server, check if it's running:
   - Check the process or port: `ss -tlnp | grep :{port}`
   - Or check the config exists: `cat /opt/nexaas/mcp/configs/{server}.yaml`

4. Check which skills require which MCP servers:
   - For each deployed skill, read `contract.yaml` and extract `requires` and `mcp_servers` fields

5. Present a table showing:
   - Server name, port, status (running/stopped/not configured)
   - Which skills depend on it
   - Required environment variables and whether they're set

Flag any missing integrations that deployed skills need.
