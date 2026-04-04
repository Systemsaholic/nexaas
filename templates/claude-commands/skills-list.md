List all skills on this instance — both deployed and available from the orchestrator.

1. Read the local skills registry: `cat /opt/nexaas/skills/_registry.yaml`
2. For each deployed skill, read its contract: `cat /opt/nexaas/skills/{category}/{name}/contract.yaml`
3. Check which skills are active vs inactive by querying the workspace_skills table if accessible
4. Query the orchestrator for the full skill library: `curl -s http://10.10.0.10:3000/api/v1/skills/packages -H "Authorization: Bearer $(grep ADMIN_SECRET /opt/nexaas/.env | cut -d= -f2)" 2>/dev/null`
5. Present a clear table showing: skill ID, type (simple/agentic), version, status (active/inactive/available on orchestrator), and one-line description

Format the output as a clean table. Highlight any skills available on the orchestrator that aren't deployed here.
