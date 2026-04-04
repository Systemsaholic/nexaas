Deploy a skill package from the orchestrator to one or more client instances.

The operator will specify the skill and target: $ARGUMENTS

1. Verify the skill exists: `cat /opt/nexaas/skills/{category}/{name}/contract.yaml`

2. List available instances:
   `ls /opt/nexaas/workspaces/*.workspace.json | grep -v _template`

3. For the target instance, read its manifest:
   `cat /opt/nexaas/workspaces/{workspace-id}.workspace.json`

4. Check compatibility — does the instance have the required MCP servers and capabilities from the skill's contract?

5. Rsync the skill to the instance:
   ```bash
   rsync -av /opt/nexaas/skills/{category}/{name}/ ubuntu@{instance-ip}:/opt/nexaas/skills/{category}/{name}/
   ```

6. Update the workspace_skills table on the orchestrator:
   ```sql
   psql nexaas -c "INSERT INTO workspace_skills (workspace_id, skill_id, active) VALUES ('{workspace-id}', '{category}/{name}', false) ON CONFLICT DO NOTHING"
   ```

7. Report deployment status and what the operator needs to do next:
   - Run onboarding on the instance (via Claude Code or dashboard)
   - Configure required integrations
   - Validate and activate

To deploy to ALL instances, loop through each workspace manifest.
