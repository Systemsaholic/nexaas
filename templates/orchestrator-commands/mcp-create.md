Create a new MCP server integration for the Nexaas platform.

The operator will describe what integration they need: $ARGUMENTS

1. Check the existing MCP registry to avoid duplicates:
   `cat /opt/nexaas/mcp/_registry.yaml`

2. Determine the server details:
   - Server ID (lowercase, hyphenated)
   - Display name
   - Default port (check registry for next available, starting from 3100)
   - Capabilities (what tools it exposes)
   - Required environment variables (API keys, URLs, credentials)

3. Create the server config in `/opt/nexaas/mcp/configs/{server-id}.yaml`:
   ```yaml
   command: npx  # or python, node, etc.
   args:
     - -y
     - "@modelcontextprotocol/server-{name}"  # or custom package
   env:
     API_KEY: "${ENV_VAR_NAME}"
   ```

4. Add the server to `/opt/nexaas/mcp/_registry.yaml` following the existing format:
   ```yaml
   - id: server-id
     name: Display Name
     description: What it does
     defaultPort: 31XX
     capabilities: [list, of, capabilities]
     requiredEnv: [ENV_VAR_1, ENV_VAR_2]
     config: configs/server-id.yaml
   ```

5. If the MCP server needs a custom implementation (not an existing npm package):
   - Create `/opt/nexaas/mcp/servers/{server-id}/` directory
   - Build the MCP server using the MCP SDK (@modelcontextprotocol/sdk)
   - Include package.json, index.ts, and README.md
   - Update the config to point to the custom server

6. After creating, commit to git:
   ```bash
   git add mcp/
   git commit -m "mcp: add {server-id} integration"
   git push
   ```

7. Report what was created and how to deploy it to instances:
   - Instance operators can pull it with: `rsync -av ubuntu@10.10.0.10:/opt/nexaas/mcp/configs/{server-id}.yaml /opt/nexaas/mcp/configs/`
   - Or the maintenance task will sync it automatically on the next hourly sweep

The MCP server must follow the Model Context Protocol specification. Use existing packages from npm (@modelcontextprotocol/*) when available.
