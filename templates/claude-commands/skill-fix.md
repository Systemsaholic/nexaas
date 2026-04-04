Diagnose and fix a skill issue on this instance.

The user will describe the problem or specify the skill: $ARGUMENTS

1. Identify the skill in question. If not specified, check recent worker logs for failures:
   `journalctl -u nexaas-worker --no-pager -n 200 --since '24 hours ago' | grep -i error`

2. Read the skill's contract and prompt:
   `cat /opt/nexaas/skills/{category}/{name}/contract.yaml`
   `cat /opt/nexaas/skills/{category}/{name}/system-prompt.hbs`
   `cat /opt/nexaas/skills/{category}/{name}/tag-routes.yaml`

3. Check the client config for this skill:
   `cat /opt/nexaas/config/{category}/{name}.yaml 2>/dev/null`

4. Diagnose the root cause — is it:
   - Missing integration/MCP server?
   - Client config incomplete (onboarding not done)?
   - Prompt issue?
   - TAG routing misconfiguration?
   - Contract requirement not met?

5. Fix the issue locally on this instance

6. After fixing, flag the improvement for the orchestrator:
   ```sql
   psql nexaas -c "INSERT INTO skill_feedback (skill_id, workspace_id, signal, claude_reflection, collected) VALUES ('{skill_id}', '$(grep NEXAAS_WORKSPACE /opt/nexaas/.env | cut -d= -f2)', 'skill_improvement', 'DESCRIBE THE FIX GENERICALLY — no client names or data', false)"
   ```

IMPORTANT: When flagging the improvement, describe it generically. No client names, no specific data, no workspace context. The improvement must be applicable to all instances.
