# Add Integration

You are connecting an MCP server integration to this workspace. Walk through each step interactively.

## Step 1: Select Integration Type

Ask the user which type of integration they want to add:

| Type | Description | Examples |
|------|-------------|----------|
| **email** | Email sending/receiving | Gmail, Outlook, SMTP |
| **crm** | Customer relationship management | HubSpot, Salesforce, Pipedrive |
| **dns** | Domain management | Cloudflare, Route53, Namecheap |
| **social** | Social media platforms | Twitter/X, LinkedIn, Instagram |
| **database** | External databases | PostgreSQL, MySQL, Supabase |
| **messaging** | Chat and notifications | Slack, Discord, Telegram |
| **custom** | Custom MCP server | Any MCP-compatible server |

Wait for their selection.

## Step 2: Gather Connection Details

Based on the integration type, ask for the relevant connection details:

### For all types:
- **Server name** (identifier used in .mcp.json)
- **Transport type**: `stdio` (local command) or `sse` (remote URL)

### For stdio transport:
- **Command** to launch the server (e.g., `npx`, `uvx`, path to binary)
- **Arguments** (as a list)
- **Environment variables** (API keys, tokens, etc.)

### For sse transport:
- **URL** of the MCP server endpoint
- **Headers** (authentication tokens, API keys)

Provide sensible defaults and examples based on the chosen integration type. For example:
- Email (Gmail): `npx @anthropic/mcp-gmail` with OAuth credentials
- CRM (HubSpot): `npx @anthropic/mcp-hubspot` with API key
- DNS (Cloudflare): `npx @anthropic/mcp-cloudflare` with API token

## Step 3: Update .mcp.json

Read the existing `{workspace_root}/.mcp.json` file (create it if it doesn't exist). Add the new server entry.

The format is:

```json
{
  "mcpServers": {
    "{server_name}": {
      "command": "{command}",
      "args": ["{arg1}", "{arg2}"],
      "env": {
        "API_KEY": "{value}"
      }
    }
  }
}
```

Or for SSE transport:

```json
{
  "mcpServers": {
    "{server_name}": {
      "url": "{sse_url}",
      "headers": {
        "Authorization": "Bearer {token}"
      }
    }
  }
}
```

Merge the new entry into the existing `mcpServers` object, preserving existing entries.

## Step 4: Test Connection

Tell the user: "The integration has been added to `.mcp.json`. To test the connection, you will need to restart Claude Code so it picks up the new MCP server configuration."

Suggest they verify by running `/workspace-status` after restarting.

## Step 5: Update CLAUDE.md

Append to the `CLAUDE.md` file a section under `## Connected Integrations` listing the new server:

```markdown
## Connected Integrations

### {server_name} ({type})
- Transport: {stdio|sse}
- Added: {date}
- Tools: (available after restart)
```

If the section already exists, append the new entry to it.

## Completion

Summarize:
- Integration name and type
- Configuration file updated
- Remind user to restart Claude Code to activate the MCP server
- Suggest next steps (e.g., create an agent that uses this integration)
