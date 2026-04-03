# Contribute Upstream

Contribute fixes and improvements from a customer deployment back to the Nexaas framework.

## Usage

```
/contribute
```

## What It Does

1. Detects changes in the current deployment
2. Categorizes as framework (contributable) vs customer-specific (excluded)
3. Checks for sensitive data (API keys, secrets)
4. Creates a feature branch from latest main
5. Stages framework-level changes only
6. Creates commit with proper attribution
7. Pushes and creates PR

## Change Categories

| Category | Action | Examples |
|----------|--------|----------|
| Framework | Contribute | MCP configs, prompts, skills, engine code |
| Customer | Exclude | Registry data, workspace.yaml, API keys |
| Unknown | Review | New files outside standard paths |

## Sensitive Data Check

The skill scans for patterns like:
- `sk-live-*`, `sk-test-*`
- `api_key = "..."`
- `token = "..."`
- `password = "..."`

If found, contribution is blocked until secrets are removed.

## After Contribution

Once PR is merged, update all customer deployments:

```bash
bash scripts/update.sh --force
```

Content-only changes (prompts, configs) apply immediately without restart.

## Manual Alternative

```bash
bash scripts/contribute.sh

# Or dry-run first
bash scripts/contribute.sh --dry-run
```

## See Also

- [Playbook: Contributing Upstream](../playbooks/08-contribute-upstream.md)
- [Auto-Update Script](../../scripts/update.sh)
