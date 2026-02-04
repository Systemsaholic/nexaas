# Framework Rules

Rules for content inside `framework/`. Everything here ships with Nexaas and must remain workspace-agnostic.

## 1. No Business-Specific Content

- No real company names, domains, or email addresses.
- No API keys, secrets, or credentials.
- No hardcoded IP addresses or internal hostnames.
- Use placeholders: `{{COMPANY_NAME}}`, `{{AGENT_NAME}}`, `{{DOMAIN}}`.

## 2. Workspace Always Wins

When a workspace defines an agent or skill with the same name as a framework item, the workspace version takes precedence. Framework items are defaults, not overrides.

## 3. Placeholder Conventions

| Placeholder | Meaning |
|---|---|
| `{{COMPANY_NAME}}` | The deployer's company name |
| `{{AGENT_NAME}}` | An agent's slug (lowercase, hyphenated) |
| `{{DOMAIN}}` | A domain name |
| `{{REGISTRY_NAME}}` | A registry slug |

## 4. File Format Requirements

- Agent configs: `config.yaml` inside a named directory under `agents/`.
- Agent prompts: `prompt.md` alongside `config.yaml`.
- Skills: single `.md` file in `skills/`.
- Registries: `.yaml` file with `name`, `fields`, `entries`.
- Memory files: `followups.yaml` and `checks.yaml` with list items.

## 5. Validation Checklist

Before merging changes to `framework/`:

- [ ] No API keys, passwords, or secrets
- [ ] No real email addresses or phone numbers
- [ ] No hardcoded IPs or private network paths
- [ ] No company-specific business logic
- [ ] All examples use placeholders
- [ ] Agent configs parse without errors
- [ ] Skill markdown has a `# Heading` and description line

Run `framework/scripts/validate-framework.sh` to automate these checks.
