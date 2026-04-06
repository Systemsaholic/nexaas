Run the Foundation Skill to onboard a new client instance.

The operator will specify the workspace: $ARGUMENTS

1. First check the workspace exists:
   `cat /opt/nexaas/workspaces/{workspace-id}.workspace.json`

2. Gather the following information about the client's business (ask the operator or use what's provided):

   **Business Identity:**
   - Business name, industry, description
   - Key people (name, role, email, what they handle)
   - Timezone

   **Brand Voice:**
   - Communication tone (casual, professional, etc.)
   - Words/phrases to never use
   
   **Departments to activate:**
   - Which of: sales, marketing, accounting, customer-service, hr, it, seo

   **Contracts:**
   - What needs approval before the AI acts?
   - What should never be automated?
   - Hard limits (things the AI must never do)
   - Who gets escalations for financial, legal, complaints?

   **Channels:**
   - How does each key person prefer to be reached?

3. Once you have the information, trigger the Foundation Skill:
   ```bash
   curl -s -X POST "http://localhost:3040/api/v1/tasks/client-onboarding/trigger" \
     -H "Authorization: Bearer $(grep TRIGGER_SECRET_KEY /opt/nexaas/.env | cut -d= -f2)" \
     -H "Content-Type: application/json" \
     -d '{
       "payload": {
         "workspaceId": "...",
         "businessName": "...",
         "industry": "...",
         "businessDescription": "...",
         "keyPeople": [...],
         "brandTone": "...",
         "neverSay": [...],
         "departments": [...],
         "approvalGates": {...},
         "hardLimits": [...],
         "escalationRules": {...},
         "channelPreferences": {...},
         "connectedTools": [...],
         "timezone": "..."
       }
     }'
   ```

4. Verify the output:
   - Check `/opt/nexaas/identity/{workspace}/` for generated docs
   - Check `/opt/nexaas/config/client-profile.yaml` for contract
   - Check channel_registry table: `psql nexaas -c "SELECT * FROM channel_registry WHERE workspace_id = '{workspace}'"`

5. Report what was generated and next steps (skill activation, HEARTBEAT provisioning)
