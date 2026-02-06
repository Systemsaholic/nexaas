# Contributing Improvements Upstream

When you fix bugs or improve prompts/MCP servers on a customer deployment, contribute them back to the framework so all customers benefit.

## Quick Reference

```bash
# From customer deployment, run the contribute skill
/contribute

# Or manually (with sanitization checks)
bash scripts/contribute.sh

# Dry-run to preview without changes
bash scripts/contribute.sh --dry-run
```

## Sanitization Guardrails

The contribution script automatically blocks customer-specific content:

| Blocked | Examples |
|---------|----------|
| API keys/tokens | `sk-live-*`, `ghp_*`, bearer tokens |
| Customer domains | `@acme.com`, `https://client-site.io` |
| Company names | "Acme Corp", "XYZ Industries" |
| Webhook URLs | Slack/Discord hooks |
| Phone numbers | Customer contact info |
| Account IDs | `user_id`, `org_id` values |

**Allowed placeholders:**
- `${API_KEY}`, `${BASE_URL}` — environment variables
- `your-api-key-here` — obvious placeholders
- `example.com` — example domain
- `<PLACEHOLDER>` — template markers

## When to Contribute

| Change Type | Contribute? | Example |
|-------------|-------------|---------|
| Bug fix in MCP server | Yes | Fixed API response parsing in late.dev |
| Prompt improvement | Yes | Better error handling in social-inbox prompt |
| New skill | Yes | Added image-validation skill |
| Agent optimization | Yes | Reduced token usage in content-publisher |
| Customer-specific config | No | Custom API keys, branding, registry data |
| Customer-specific agent | Maybe | Generic enough? Extract and generalize |

## Contribution Workflow

### 1. Identify Changes

From the customer workspace, see what's been modified:

```bash
# Compare workspace to framework defaults
diff -rq framework/ workspace/ --exclude="*.db" --exclude="registries"

# Or use git to see uncommitted changes
git status
git diff
```

### 2. Categorize Changes

**Framework changes** (contribute these):
- `framework/mcp-servers/*.yaml` — MCP server configs
- `framework/agents/*/prompt.md` — Default agent prompts
- `framework/skills/*.md` — Skills
- `framework/templates/*` — Templates
- `engine/**/*.py` — Engine code fixes
- `dashboard/**/*.tsx` — Dashboard fixes

**Workspace overrides** (don't contribute):
- `workspace/registries/*` — Customer data
- `workspace/agents/*/config.yaml` with customer API keys
- `workspace/workspace.yaml` with customer branding

### 3. Create Contribution Branch

```bash
# Ensure you're on latest main
git fetch origin main
git checkout -b fix/social-inbox-parsing

# Stage only framework-level changes
git add framework/mcp-servers/late-dev.yaml
git add framework/agents/social-inbox/prompt.md
# Do NOT add workspace/ files with customer data
```

### 4. Write Clear Commit Message

```bash
git commit -m "$(cat <<'EOF'
Fix social inbox API response parsing

- Handle paginated responses from late.dev API
- Add retry logic for rate limits
- Improve error messages for auth failures

Discovered on: Customer XYZ deployment
Tested on: Phoenix Voyages, BrightWave

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

### 5. Push and Create PR

```bash
git push origin fix/social-inbox-parsing

# Create PR
gh pr create --title "Fix social inbox API response parsing" --body "$(cat <<'EOF'
## Summary
- Handle paginated responses from late.dev API
- Add retry logic for rate limits
- Improve error messages for auth failures

## Testing
- [x] Tested on customer deployment (XYZ)
- [x] Verified on Phoenix Voyages
- [ ] Needs testing on fresh deployment

## Rollout
After merge, all deployments will receive this fix via `scripts/update.sh`
EOF
)"
```

### 6. After Merge — Update All Deployments

Once PR is merged, customer deployments auto-update (if cron enabled) or manually:

```bash
# On each customer server
bash scripts/update.sh --force
```

The smart update script will detect it's a content-only change (prompts/configs) and apply without restart.

## Handling Sensitive Data

Never commit:
- API keys or tokens
- Customer names in code (use "Customer XYZ" in commit messages only)
- Customer-specific registry data
- Passwords or secrets

If a fix requires showing an example:
```yaml
# Good - use placeholders
api_key: ${LATE_DEV_API_KEY}

# Bad - never commit real keys
api_key: sk-live-abc123...
```

## Generalizing Customer-Specific Improvements

Sometimes a customer-specific agent is useful for everyone:

### Before (customer-specific)
```yaml
# workspace/agents/xyz-social/config.yaml
name: xyz-social
description: Social media manager for XYZ Corp
```

### After (generalized for framework)
```yaml
# framework/agents/social-manager/config.yaml
name: social-manager
description: Social media content manager
# Remove customer-specific references
```

## Conflict Resolution

If your fix conflicts with recent framework changes:

```bash
# Update your branch
git fetch origin main
git rebase origin/main

# Resolve conflicts
# Edit conflicted files
git add <resolved-files>
git rebase --continue

# Force push updated branch
git push origin fix/social-inbox-parsing --force-with-lease
```

## Tracking Contributions

Add to your PR description:
- Which customer deployment discovered the issue
- Which other deployments were tested
- Expected impact (all deployments vs specific MCP users)

This helps prioritize review and rollout.
