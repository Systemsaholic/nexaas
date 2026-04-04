Run the onboarding questions for a skill to generate the client config.

The user will specify which skill: $ARGUMENTS

1. Find the skill's onboarding questions:
   `cat /opt/nexaas/skills/{category}/{name}/onboarding-questions.yaml`

2. Walk through each question with the operator:
   - Present the question in plain language
   - Show the available options (if any)
   - For freetext questions, show the examples
   - Mark which questions are required vs optional

3. Collect all answers

4. Generate the config YAML from the answers, mapping each answer to its `maps_to` field

5. Write the config to the instance:
   `mkdir -p /opt/nexaas/config/{category}/`
   Write to: `/opt/nexaas/config/{category}/{name}.yaml`

6. After saving, validate the skill can run:
   - Check all required config fields are present
   - Check required integrations are connected
   - Report readiness status

Present questions one at a time, conversationally. Don't dump them all at once.
