# /new-mcp — Create a New MCP Server Integration

Build a new MCP server for integrating with an external system.

The operator will describe the integration they need: $ARGUMENTS

## Before Starting

1. **Check existing MCP servers** — maybe it already exists:
   ```bash
   cat ~/.mcp.json 2>/dev/null | python3 -c "import json,sys; [print(f'  {k}') for k in sorted(json.load(sys.stdin).get('mcpServers',{}).keys())]"
   ```

2. **Check the Nexaas capability registry** — maybe the capability already has an interface:
   ```bash
   cat /opt/nexaas/capabilities/_registry.yaml | head -50
   ```

## Phase 1: Integration Profile

Ask:
1. **What system are you integrating with?** (e.g., "Wave Accounting", "Shopify", "custom REST API")
2. **What operations do you need?** (read data, write data, both)
3. **What auth method?** (API key, OAuth, bearer token, none)
4. **Is there an existing library/SDK?** (npm package, Python lib)

## Phase 2: Capability Mapping

Determine if this maps to an existing Nexaas capability:
- `bank-source` — for bank/financial data
- `accounting-system` — for accounting operations
- `document-store` — for document management
- `email-inbox` / `email-outbound` — for email
- `messaging-inbound` / `messaging-outbound` — for chat/SMS
- `crm` — for contacts/deals
- `calendar` — for scheduling
- Or: **new capability** — define the interface

## Phase 3: Choose Implementation Path

**Simple (API key + REST):** Build as a Node.js MCP server using `@modelcontextprotocol/sdk`.

**Complex (OAuth + state):** Build with a proper OAuth flow, token storage in `integration_connections`, and refresh handling.

## Phase 4: Scaffold

Create the MCP server directory:
```bash
mkdir -p ~/mcp-servers/{name}
cd ~/mcp-servers/{name}
npm init -y
npm install @modelcontextprotocol/sdk zod
```

Create the main server file with the MCP stdio protocol:
- `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`
- `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`
- Define each tool with `server.tool(name, description, schema, handler)`
- Start with `server.connect(new StdioServerTransport())`

## Phase 5: Register in .mcp.json

Add the server to the workspace's `.mcp.json`:
```json
"{name}": {
  "command": "node",
  "args": ["~/mcp-servers/{name}/index.js"],
  "env": {
    "API_KEY": "..."
  }
}
```

## Phase 6: Test

1. Restart any Claude Code session to pick up the new MCP
2. Try calling the tools directly
3. If it works, register the capability in the palace:
   ```
   palace_write(wing="knowledge", hall="integrations", room="{name}", content="MCP server for {system}: tools available, auth method, capabilities")
   ```

## Rules

- **All MCP servers must be registered** in `.mcp.json` to be usable
- **Use the stdio protocol** (not HTTP) for Claude Code compatibility
- **Tool schemas must include `inputSchema` with `type: "object"`** — the Anthropic API requires this
- **Test before declaring done** — actually call the tools from Claude Code
