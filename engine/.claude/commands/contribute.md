# Contribute Upstream

You are helping the user contribute fixes and improvements from this customer deployment back to the Nexaas framework. This ensures all customers benefit from bug fixes and enhancements.

## Step 1: Detect Changes

First, check what has been modified in this deployment:

```bash
git status --porcelain
```

Categorize the changes:

**Framework files (contributable):**
- `framework/` — agents, skills, MCP configs, playbooks, templates
- `engine/` — Python backend code
- `dashboard/` — TypeScript/React frontend code
- `scripts/` — deployment and utility scripts
- `docs/` — documentation

**Customer-specific (exclude):**
- `workspace/` — customer data, registries, custom configs
- `.env*` — environment variables with secrets
- `data/` — database files
- `backups/` — backup files

Show the user what was detected and ask them to confirm which changes they want to contribute.

## Step 2: Sanitization Check

**CRITICAL**: Before proceeding, scan all contributable files for customer-specific content.

Check for and BLOCK if found:
- API keys: `sk-live-*`, `sk-test-*`, `ghp_*`, `xox*-*`
- Tokens: Bearer tokens, secrets, passwords
- Customer domains: Real company URLs (not `example.com` or `localhost`)
- Company names: "XYZ Corp", "Acme Industries", etc.
- Webhook URLs: Slack/Discord hooks
- Phone numbers: Customer contact info
- Account IDs: `user_id`, `org_id` with real values

**Allowed placeholders:**
- `${API_KEY}`, `${BASE_URL}` — environment variable syntax
- `example.com`, `localhost` — example domains
- `your-api-key-here` — obvious placeholders
- `<PLACEHOLDER>`, `TODO`, `CHANGEME` — markers

If sensitive content is found:
1. Show the user exactly what was detected and where
2. Explain how to replace with placeholders
3. Wait for them to fix the issues
4. Re-scan before proceeding

Example guidance:
```
Found in framework/mcp-servers/late-dev.yaml:
  Line 12: api_key: "sk-live-abc123..."

Replace with:
  api_key: ${LATE_DEV_API_KEY}
```

## Step 3: Create Branch

Once sanitization passes, create a contribution branch:

```bash
git fetch origin main
git checkout -b fix/descriptive-name origin/main
```

Ask the user for a descriptive branch name. Suggest prefixes:
- `fix/` — bug fixes
- `feat/` — new features
- `docs/` — documentation updates
- `refactor/` — code improvements

## Step 4: Stage Files

Stage only the framework-level files (NOT workspace/):

```bash
git add framework/path/to/file.yaml
git add engine/path/to/file.py
# etc.
```

Show the user what will be staged and confirm.

## Step 5: Create Commit

Help the user write a good commit message:

```
<type>: <short description>

<detailed explanation of what was fixed/changed>

Discovered on: <deployment name>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

Example:
```
fix: Handle paginated responses in social inbox MCP

- Added pagination loop for large result sets
- Added retry logic for rate limit errors
- Improved error messages for auth failures

Discovered on: Phoenix Voyages

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## Step 6: Push and Create PR

Push the branch and create a pull request:

```bash
git push origin <branch-name>
gh pr create --title "<title>" --body "<body>"
```

PR body template:
```markdown
## Summary
<bullet points of what changed>

## Sanitization
- [x] No API keys or secrets
- [x] No customer-specific domains
- [x] No company names or PII
- [x] Uses placeholders where needed

## Testing
- [x] Tested on <deployment name>
- [ ] Needs testing on fresh deployment

## Rollout
After merge, all deployments receive this fix via `scripts/update.sh`
```

## Step 7: Completion

Summarize:
- Branch name and PR URL
- Files contributed
- Sanitization status
- Next steps:
  1. Wait for PR review/merge
  2. After merge, run `bash scripts/update.sh --force` on other deployments

Remind the user that content-only changes (prompts, configs) apply immediately without restart.

## Quick Alternative

If the user prefers the automated script:

```bash
bash scripts/contribute.sh
```

This runs all steps with built-in sanitization checks.
