Sync this instance with the orchestrator — pull latest skills, configs, and templates.

1. Pull latest CLAUDE.md template:
   `rsync -av ubuntu@10.10.0.10:/opt/nexaas/templates/instance-CLAUDE.md /tmp/instance-CLAUDE.md`
   Then apply workspace-specific substitutions and update `/opt/nexaas/CLAUDE.md`

2. Pull latest skill packages for all deployed skills:
   - Read `/opt/nexaas/skills/_registry.yaml` for deployed skills
   - For each: `rsync -av ubuntu@10.10.0.10:/opt/nexaas/skills/{category}/{name}/ /opt/nexaas/skills/{category}/{name}/`

3. Pull latest MCP configs:
   `rsync -av ubuntu@10.10.0.10:/opt/nexaas/mcp/ /opt/nexaas/mcp/`

4. Pull latest command templates:
   `rsync -av ubuntu@10.10.0.10:/opt/nexaas/templates/claude-commands/ /opt/nexaas/.claude/commands/`

5. Report what was updated (show diffs if files changed)
