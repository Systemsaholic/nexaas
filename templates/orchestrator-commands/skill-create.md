Create a new skill package on the orchestrator.

The operator will describe what skill they need: $ARGUMENTS

1. Check existing skills to avoid duplicates:
   `cat /opt/nexaas/skills/_registry.yaml`

2. Determine the skill details following the Nexaas architecture:
   - Category (msp, finance, marketing, hr, operations, sales, custom)
   - Skill name (kebab-case)
   - Type: simple (single API call) or agentic (multi-step with MCP tools)
   - Description
   - Required MCP servers

3. Create the full skill package at `/opt/nexaas/skills/{category}/{name}/`:

   **contract.yaml** — Define:
   - execution model (simple/agentic, model, tokens, timeout)
   - adapters (if applicable)
   - requires (integrations + scopes)
   - client_must_configure (required + optional fields from onboarding)
   - platform_locked (non-overridable rules)
   - reads_from_context (CAG layers)
   - rag namespaces
   - produces (workflow state outputs)
   - tag_defaults (route assignments)

   **onboarding-questions.yaml** — Plain-language questions that:
   - Map one question → one config field
   - Use options over freetext where possible
   - Include examples for freetext fields
   - Mark required vs optional

   **system-prompt.hbs** — Handlebars template with:
   - {{slots}} for all CAG context fields
   - Behavioral contract section
   - Sender/entity context
   - RAG chunks injection
   - Platform rules (non-negotiable)
   - Response format (JSON)
   - Self-Reflection Protocol (SKILL_IMPROVEMENT_CANDIDATE)

   **tag-routes.yaml** — Route definitions:
   - auto_execute, notify_after, approval_required, escalate, flag, defer
   - Each with conditions and actions

   **rag-config.yaml** — Retrieval strategy:
   - primary: [tenant]_knowledge
   - skill_docs: skill/{name}
   - fallback: global/{category}_policies

   **CHANGELOG.md** — Version 1.0.0 entry

4. Add the skill to `/opt/nexaas/skills/_registry.yaml`

5. Commit to git:
   ```bash
   git add skills/
   git commit -m "skill: create {category}/{name} v1.0.0"
   git push
   ```

6. Report what was created and next steps (deploy to instance, onboard, activate)

IMPORTANT: Skills must be CLIENT-AGNOSTIC. No client-specific logic. All customization via onboarding config + CAG context.
