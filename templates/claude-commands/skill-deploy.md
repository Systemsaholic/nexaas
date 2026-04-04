Deploy a skill from the orchestrator to this instance.

The user will specify which skill to deploy: $ARGUMENTS

1. First, check what's available on the orchestrator:
   `curl -s http://10.10.0.10:3000/api/v1/skills/packages -H "Authorization: Bearer $(grep ADMIN_SECRET /opt/nexaas/.env | cut -d= -f2)" | jq '.data[].id'`

2. If the skill exists, pull it via rsync:
   `rsync -av ubuntu@10.10.0.10:/opt/nexaas/skills/{category}/{name}/ /opt/nexaas/skills/{category}/{name}/`

3. Read the skill's contract.yaml to understand what it requires:
   `cat /opt/nexaas/skills/{category}/{name}/contract.yaml`

4. Check if the required MCP servers and integrations are available on this instance

5. Update the local `skills/_registry.yaml` to include the new skill if it's not already listed

6. Report what was deployed and what's needed next (onboarding, integration setup, activation)

If the skill requires integrations that aren't configured, list what's missing and explain how to set them up.
