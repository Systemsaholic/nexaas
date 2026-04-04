Show the workspace configuration for this instance.

1. Read the workspace manifest:
   `cat /opt/nexaas/workspaces/$(grep NEXAAS_WORKSPACE /opt/nexaas/.env | cut -d= -f2).workspace.json`

2. Read the .env (show keys only, NOT values for secrets):
   `grep -v '^#' /opt/nexaas/.env | grep -v '^$' | sed 's/=.*/=***/'`

3. Show deployed skills and their configs:
   `ls /opt/nexaas/skills/*/`
   `ls /opt/nexaas/config/ 2>/dev/null`

4. Present a clean summary:
   - Workspace ID and name
   - Network: private IP, public IP
   - Trigger.dev project ref
   - Deployed skills with status
   - Enabled MCP servers
   - Capabilities (playwright, docker, bash)
