# Playbook 07: MCP Integration

Configure Model Context Protocol (MCP) servers for your workspace.

## Prerequisites

- Workspace deployed and engine running
- Claude Code authenticated in the engine container

## MCP Server Catalog

The framework ships a catalog of MCP servers in `framework/mcp-servers/`. List the available servers:

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/mcp-catalog
```

Available servers:

| Server | Category | Description | Requires |
|---|---|---|---|
| `filesystem` | infrastructure | Read/write workspace files | — |
| `fetch` | infrastructure | Fetch content from URLs | — |
| `memory` | infrastructure | Persistent key-value memory | — |
| `sequential-thinking` | infrastructure | Step-by-step reasoning | — |
| `postgres` | infrastructure | PostgreSQL queries | `POSTGRES_CONNECTION_STRING` |
| `brave-search` | search | Web search via Brave | `BRAVE_API_KEY` |
| `github` | development | GitHub repos, issues, PRs | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `email` | communication | IMAP/SMTP email management | `IMAP_HOST`, `SMTP_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` |
| `telegram` | communication | Telegram bot notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `slack` | communication | Slack messaging | `SLACK_BOT_TOKEN` |
| `groundhogg` | crm | WordPress CRM / marketing automation | `GROUNDHOGG_URL`, `GROUNDHOGG_API_KEY`, `GROUNDHOGG_API_SECRET` |
| `nextcloud` | productivity | File and calendar management | `NEXTCLOUD_URL`, `NEXTCLOUD_USER`, `NEXTCLOUD_PASSWORD` |
| `vaultwarden` | secrets | Self-hosted password manager | `VAULTWARDEN_URL`, `VAULTWARDEN_API_KEY` |
| `docuseal` | documents | E-signature and document management | `DOCUSEAL_URL`, `DOCUSEAL_API_KEY` |

## Enabling Framework Servers

Edit `workspace/.mcp.json` and add server names to `enabledFrameworkServers`:

```json
{
  "mcpServers": {},
  "enabledFrameworkServers": ["filesystem", "fetch", "memory"]
}
```

The engine merges the framework config for each enabled server into `mcpServers` at runtime. If you define a server with the same name in `mcpServers`, your workspace version takes precedence.

## Servers Requiring Credentials

For servers that need API keys, set the environment variables in `.env` before enabling:

```bash
# .env
BRAVE_API_KEY=your-key-here
```

Then enable the server:

```json
{
  "enabledFrameworkServers": ["brave-search"]
}
```

The framework config references env vars with `${VAR_NAME}` syntax.

## Adding Custom Servers

Add custom (non-framework) servers directly to `mcpServers`:

```json
{
  "mcpServers": {
    "my-custom-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  },
  "enabledFrameworkServers": ["filesystem"]
}
```

## How Updates Work

- **New servers** added to `framework/mcp-servers/` become available in the catalog after pulling the framework update, but aren't active until an admin enables them.
- **Updates to existing servers** (e.g., new args, version bumps) take effect automatically for any instance that has the server enabled, since the engine reads the framework catalog at runtime.
- **Workspace overrides** are never affected by framework updates — if you define a server in `mcpServers` with the same name, it always wins.

## Verification

```bash
# List available servers
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/mcp-catalog

# Check merged config in workspace response
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/workspace | jq .mcp_config
```
