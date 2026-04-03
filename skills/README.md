# Nexaas Skill Registry

Skills are reusable AI capabilities that run across workspaces.

## Structure

Each skill lives in `skills/[category]/[skill-name]/` and contains:
- `skill.yaml` — manifest (id, version, resources, inputs, outputs)
- `prompt.md` — Claude instructions
- `task.ts` — Trigger.dev task wrapper (optional)
- `tests/` — test cases

## Self-Reflection Protocol

Every skill prompt MUST end with the self-reflection marker:

```
SKILL_IMPROVEMENT_CANDIDATE: [generic capability description, no client data]
```

See `templates/prompt.md` for the full template.
