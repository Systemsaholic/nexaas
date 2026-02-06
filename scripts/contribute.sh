#!/usr/bin/env bash
#
# Nexaas Contribution Helper
# Safely contributes fixes from customer deployments back to the framework
# with sanitization guardrails to prevent customer-specific content leakage
#
# Usage:
#   bash scripts/contribute.sh [--dry-run] [--skip-sanitize]
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DRY_RUN=false
SKIP_SANITIZE=false

log() { echo -e "${BLUE}[CONTRIBUTE]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
sanitize_warn() { echo -e "${MAGENTA}[SANITIZE]${NC} $1"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --skip-sanitize) SKIP_SANITIZE=true; shift ;;
        *) error "Unknown option: $1" ;;
    esac
done

# Patterns for framework-contributable files
FRAMEWORK_PATTERNS=(
    "framework/mcp-servers/"
    "framework/agents/"
    "framework/skills/"
    "framework/templates/"
    "framework/playbooks/"
    "framework/packages/"
    "engine/"
    "dashboard/components/"
    "dashboard/lib/"
    "dashboard/app/"
    "scripts/"
    "docs/"
)

# Patterns to always exclude (customer-specific)
EXCLUDE_PATTERNS=(
    "workspace/"
    ".env"
    "*.db"
    "data/"
    "backups/"
    "node_modules/"
    ".venv/"
    "__pycache__/"
    "*.log"
)

# ============================================================================
# SANITIZATION GUARDRAILS
# ============================================================================

# Sensitive data patterns (secrets, keys, tokens)
SENSITIVE_PATTERNS=(
    'sk-live-[a-zA-Z0-9]+'
    'sk-test-[a-zA-Z0-9]+'
    'sk-[a-zA-Z0-9]{20,}'
    'api[_-]?key\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'token\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'password\s*[:=]\s*["\x27][^\x27"]{4,}'
    'secret\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'bearer\s+[a-zA-Z0-9_-]{20,}'
    'ghp_[a-zA-Z0-9]{36}'
    'gho_[a-zA-Z0-9]{36}'
    'xox[baprs]-[a-zA-Z0-9-]+'
)

# Customer-specific content patterns (names, domains, identifiers)
CUSTOMER_PATTERNS=(
    # Company name patterns (capitalized words that look like company names)
    '\b[A-Z][a-z]+\s+(Corp|Inc|LLC|Ltd|Company|Co|Group|Holdings|Industries|Solutions|Services|Digital|Media|Agency|Consulting)\b'
    # Email domains (not common ones)
    '@[a-z0-9-]+\.(com|io|co|net|org)(?!\.example)'
    # Specific project/client references
    '\b(client|customer|project)[_-]?[a-z0-9]+\b'
    # URLs with specific domains (not localhost, example.com, placeholder)
    'https?://(?!localhost|127\.0\.0\.1|example\.com|placeholder)[a-z0-9.-]+\.[a-z]{2,}'
    # Slack/Discord webhook URLs
    'hooks\.(slack|discord)\.com/[a-zA-Z0-9/_-]+'
    # Phone numbers
    '\+?[0-9]{1,3}[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}'
    # Specific IDs that look customer-specific
    '\b(user|account|org|team)[_-]?id\s*[:=]\s*["\x27]?[a-z0-9-]{8,}'
)

# Words that should trigger review (might be customer-specific)
REVIEW_WORDS=(
    # Specific tool/platform names that might indicate customer customization
    "salesforce"
    "hubspot"
    "zendesk"
    "shopify"
    "stripe"
    "twilio"
    "sendgrid"
    "mailchimp"
    # Database/infra references
    "mongodb"
    "postgres"
    "redis"
    "aws"
    "gcp"
    "azure"
)

# Allowed placeholder patterns (these are OK)
ALLOWED_PLACEHOLDERS=(
    '\$\{[A-Z_]+\}'           # ${ENV_VAR}
    '\{\{[a-z_]+\}\}'         # {{template_var}}
    '<[A-Z_]+>'               # <PLACEHOLDER>
    'your-[a-z-]+-here'       # your-api-key-here
    'example\.com'            # example.com
    'placeholder'             # placeholder
    'TODO'                    # TODO markers
    'CHANGEME'                # CHANGEME markers
)

SANITIZATION_ISSUES=()
REVIEW_SUGGESTIONS=()

check_file_sanitization() {
    local file="$1"
    local filepath="$PROJECT_DIR/$file"

    if [[ ! -f "$filepath" ]]; then
        return
    fi

    local content=$(cat "$filepath")
    local issues_found=false

    # Check for sensitive data
    for pattern in "${SENSITIVE_PATTERNS[@]}"; do
        local matches=$(grep -noE "$pattern" "$filepath" 2>/dev/null || true)
        if [[ -n "$matches" ]]; then
            # Check if it's an allowed placeholder
            local is_placeholder=false
            for allowed in "${ALLOWED_PLACEHOLDERS[@]}"; do
                if echo "$matches" | grep -qE "$allowed"; then
                    is_placeholder=true
                    break
                fi
            done

            if [[ "$is_placeholder" == false ]]; then
                SANITIZATION_ISSUES+=("$file: Sensitive data pattern found")
                sanitize_warn "SENSITIVE: $file"
                echo "$matches" | head -3 | sed 's/^/    /'
                issues_found=true
            fi
        fi
    done

    # Check for customer-specific patterns
    for pattern in "${CUSTOMER_PATTERNS[@]}"; do
        local matches=$(grep -noEi "$pattern" "$filepath" 2>/dev/null || true)
        if [[ -n "$matches" ]]; then
            # Filter out allowed placeholders
            local filtered=$(echo "$matches" | grep -vE "example\.com|placeholder|your-.*-here|localhost" || true)
            if [[ -n "$filtered" ]]; then
                SANITIZATION_ISSUES+=("$file: Customer-specific content detected")
                sanitize_warn "CUSTOMER-SPECIFIC: $file"
                echo "$filtered" | head -3 | sed 's/^/    /'
                issues_found=true
            fi
        fi
    done

    # Check for review words (warning, not blocking)
    for word in "${REVIEW_WORDS[@]}"; do
        if grep -qi "\b$word\b" "$filepath" 2>/dev/null; then
            REVIEW_SUGGESTIONS+=("$file: Contains '$word' - verify it's generic")
        fi
    done
}

run_sanitization_checks() {
    if [[ "$SKIP_SANITIZE" == true ]]; then
        warn "Skipping sanitization checks (--skip-sanitize)"
        return 0
    fi

    echo ""
    echo "┌─────────────────────────────────────────┐"
    echo "│       SANITIZATION CHECKS               │"
    echo "└─────────────────────────────────────────┘"
    echo ""

    log "Scanning for customer-specific content..."

    for file in "${CONTRIBUTABLE_FILES[@]}"; do
        check_file_sanitization "$file"
    done

    # Report review suggestions (non-blocking)
    if [[ ${#REVIEW_SUGGESTIONS[@]} -gt 0 ]]; then
        echo ""
        warn "Review suggested (not blocking):"
        for suggestion in "${REVIEW_SUGGESTIONS[@]}"; do
            echo "    ? $suggestion"
        done
    fi

    # Report and block on sanitization issues
    if [[ ${#SANITIZATION_ISSUES[@]} -gt 0 ]]; then
        echo ""
        echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║  CONTRIBUTION BLOCKED - SANITIZATION REQUIRED                ║${NC}"
        echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo "The following issues must be fixed before contributing:"
        echo ""
        for issue in "${SANITIZATION_ISSUES[@]}"; do
            echo -e "  ${RED}✗${NC} $issue"
        done
        echo ""
        echo "How to fix:"
        echo "  1. Replace customer-specific values with placeholders:"
        echo "     - API keys: \${API_KEY} or 'your-api-key-here'"
        echo "     - URLs: example.com or \${BASE_URL}"
        echo "     - Company names: 'Acme Corp' or remove entirely"
        echo "  2. Remove customer-specific logic if not generalizable"
        echo "  3. Re-run: bash scripts/contribute.sh"
        echo ""
        return 1
    fi

    success "Sanitization checks passed"
    return 0
}

# ============================================================================
# FILE DETECTION
# ============================================================================

detect_changes() {
    cd "$PROJECT_DIR"

    log "Detecting changes..."

    local changed_files=$(git status --porcelain | awk '{print $2}')

    if [[ -z "$changed_files" ]]; then
        success "No changes detected"
        exit 0
    fi

    echo ""
    echo "┌─────────────────────────────────────────┐"
    echo "│         DETECTED CHANGES                │"
    echo "└─────────────────────────────────────────┘"
    echo ""

    CONTRIBUTABLE_FILES=()
    EXCLUDED_FILES=()
    NEEDS_REVIEW=()

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue

        local excluded=false

        # Check if excluded
        for pattern in "${EXCLUDE_PATTERNS[@]}"; do
            if [[ "$file" == $pattern* ]] || [[ "$file" == *"$pattern"* ]]; then
                excluded=true
                EXCLUDED_FILES+=("$file")
                break
            fi
        done

        if [[ "$excluded" == true ]]; then
            continue
        fi

        # Check if it's a framework file
        local is_framework=false
        for pattern in "${FRAMEWORK_PATTERNS[@]}"; do
            if [[ "$file" == $pattern* ]]; then
                CONTRIBUTABLE_FILES+=("$file")
                is_framework=true
                break
            fi
        done

        if [[ "$is_framework" == false ]]; then
            NEEDS_REVIEW+=("$file")
        fi

    done <<< "$changed_files"

    # Display results
    if [[ ${#CONTRIBUTABLE_FILES[@]} -gt 0 ]]; then
        success "Framework changes (will contribute):"
        for f in "${CONTRIBUTABLE_FILES[@]}"; do
            echo "    + $f"
        done
        echo ""
    fi

    if [[ ${#EXCLUDED_FILES[@]} -gt 0 ]]; then
        info "Customer-specific (excluded):"
        for f in "${EXCLUDED_FILES[@]}"; do
            echo "    - $f"
        done
        echo ""
    fi

    if [[ ${#NEEDS_REVIEW[@]} -gt 0 ]]; then
        warn "Needs review (unknown category):"
        for f in "${NEEDS_REVIEW[@]}"; do
            echo "    ? $f"
        done
        echo ""
    fi
}

# ============================================================================
# GIT OPERATIONS
# ============================================================================

create_branch() {
    echo ""
    echo -n "Enter branch name (e.g., fix/social-inbox-parsing): "
    read -r branch_name

    if [[ -z "$branch_name" ]]; then
        error "Branch name required"
    fi

    # Validate branch name
    if [[ ! "$branch_name" =~ ^(fix|feat|docs|refactor|chore)/ ]]; then
        warn "Branch should start with fix/, feat/, docs/, refactor/, or chore/"
        echo -n "Continue anyway? [y/N] "
        read -r response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            error "Cancelled"
        fi
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would create branch: $branch_name"
        return
    fi

    log "Creating branch: $branch_name"
    git fetch origin main --quiet
    git checkout -b "$branch_name" origin/main
    success "Branch created"
}

stage_files() {
    if [[ ${#CONTRIBUTABLE_FILES[@]} -eq 0 ]]; then
        warn "No framework files to contribute"
        exit 0
    fi

    echo ""
    echo "Files to stage:"
    for f in "${CONTRIBUTABLE_FILES[@]}"; do
        echo "    $f"
    done
    echo ""

    echo -n "Stage these files? [y/N] "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log "Cancelled"
        exit 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would stage ${#CONTRIBUTABLE_FILES[@]} files"
        return
    fi

    for f in "${CONTRIBUTABLE_FILES[@]}"; do
        git add "$PROJECT_DIR/$f"
    done

    success "Files staged"
}

create_commit() {
    echo ""
    echo -n "Enter commit title: "
    read -r commit_title

    if [[ -z "$commit_title" ]]; then
        error "Commit title required"
    fi

    echo "Enter commit body (press Enter twice to finish):"
    commit_body=""
    empty_lines=0
    while IFS= read -r line; do
        if [[ -z "$line" ]]; then
            empty_lines=$((empty_lines + 1))
            if [[ $empty_lines -ge 2 ]]; then
                break
            fi
            commit_body+=$'\n'
        else
            empty_lines=0
            commit_body+="$line"$'\n'
        fi
    done

    echo -n "Deployment where discovered (e.g., 'Phoenix Voyages', optional): "
    read -r deployment_ref

    local full_message="$commit_title"
    if [[ -n "$commit_body" ]]; then
        full_message+=$'\n\n'"${commit_body%$'\n'}"
    fi
    if [[ -n "$deployment_ref" ]]; then
        full_message+=$'\n\n'"Discovered on: $deployment_ref"
    fi
    full_message+=$'\n\n'"Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would commit with message:"
        echo "---"
        echo "$full_message"
        echo "---"
        return
    fi

    git commit -m "$full_message"
    success "Commit created"
}

push_and_pr() {
    local branch=$(git branch --show-current)

    echo ""
    echo -n "Push and create PR? [y/N] "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log "Skipped push. Run manually:"
        echo "    git push origin $branch"
        echo "    gh pr create"
        return
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would push branch and create PR"
        return
    fi

    log "Pushing branch..."
    git push origin "$branch"

    log "Creating PR..."
    gh pr create --fill

    success "PR created!"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║     Nexaas Contribution Helper           ║"
    echo "║     with Sanitization Guardrails         ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        warn "Running in dry-run mode (no changes will be made)"
        echo ""
    fi

    cd "$PROJECT_DIR"

    if [[ ! -d ".git" ]]; then
        error "Not a git repository"
    fi

    # Step 1: Detect changes
    detect_changes

    if [[ ${#CONTRIBUTABLE_FILES[@]} -eq 0 ]]; then
        info "No framework changes to contribute"
        exit 0
    fi

    # Step 2: Run sanitization checks (CRITICAL)
    if ! run_sanitization_checks; then
        exit 1
    fi

    # Step 3: Git operations
    create_branch
    stage_files
    create_commit
    push_and_pr

    echo ""
    success "Contribution complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Wait for PR review/merge"
    echo "  2. After merge, update other deployments:"
    echo "     bash scripts/update.sh --force"
    echo ""
}

main "$@"
