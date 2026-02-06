# Contribute Upstream

You are helping the user contribute fixes from this customer deployment back to the Nexaas framework. The workflow exports a sanitized patch that gets applied on the dev machine and pushed to GitHub.

## Workflow Overview

```
Customer Server → Export Patch → Dev Machine → GitHub → All Deployments
```

## Step 1: Run the Export Script

First, run the contribution script to detect and sanitize changes:

```bash
bash scripts/contribute.sh --export
```

This will:
1. Detect framework vs customer-specific changes
2. Run sanitization checks (blocks secrets, customer names, etc.)
3. Create a patch file in `exports/`

## Step 2: Review Detected Changes

The script categorizes files:

**Framework (will export):**
- `framework/` — agents, skills, MCP configs, playbooks
- `engine/` — Python backend code
- `dashboard/` — frontend components
- `scripts/` — deployment scripts
- `docs/` — documentation

**Customer-specific (excluded):**
- `workspace/` — customer data and configs
- `.env*` — secrets
- `data/`, `backups/` — databases

## Step 3: Sanitization Check

The script automatically blocks:
- API keys: `sk-live-*`, `sk-test-*`, `ghp_*`
- Tokens and secrets
- Customer company names
- Real domain names (not `example.com`)
- Webhook URLs, phone numbers

**If blocked**, fix the issues:
```yaml
# Before (blocked)
api_key: "sk-live-abc123"

# After (allowed)
api_key: ${LATE_DEV_API_KEY}
```

Then re-run: `bash scripts/contribute.sh --export`

## Step 4: Transfer Patch to Dev Machine

Once the patch is created, copy it to your dev machine:

```bash
scp exports/nexaas-patch-*.patch user@dev-server:/path/to/nexaas/exports/
```

## Step 5: Apply on Dev Machine

On your dev machine (where you have git push access):

```bash
cd /path/to/nexaas
git checkout -b fix/description-here
git apply exports/nexaas-patch-*.patch
git add -A
git commit -m "Fix: description

Discovered on: Customer Name

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
git push origin fix/description-here
gh pr create --fill
```

## Step 6: After Merge — Update All Deployments

Once the PR is merged, update all customer deployments:

```bash
# Update all configured deployments
bash scripts/update-all.sh

# Or update a single deployment
ssh user@customer.example.com "cd /opt/nexaas && bash scripts/update.sh --force"
```

## Configuration

Configure your deployments for `update-all.sh`:

```bash
mkdir -p ~/.nexaas
cat > ~/.nexaas/deployments.conf << 'EOF'
user@customer-a.example.com:/opt/nexaas
user@customer-b.example.com:/opt/nexaas
user@customer-c.example.com:/opt/nexaas
EOF
```

## Quick Reference

```bash
# On customer server: export sanitized patch
bash scripts/contribute.sh --export

# Copy to dev machine
scp exports/*.patch user@dev:/path/nexaas/exports/

# On dev machine: apply, commit, push
git apply exports/*.patch && git add -A && git commit && git push

# After merge: update all deployments
bash scripts/update-all.sh
```
