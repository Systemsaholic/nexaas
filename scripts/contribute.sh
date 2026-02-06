#!/usr/bin/env bash
#
# Nexaas Contribution Helper
# Exports sanitized fixes from a customer deployment to your dev machine
#
# Usage:
#   bash scripts/contribute.sh [--export] [--dry-run]
#
# Workflow:
#   1. Fix bug on customer server
#   2. Run: bash scripts/contribute.sh --export
#   3. Copy exported patch to dev machine
#   4. On dev machine: git apply, review, push
#   5. Run update-all.sh to propagate to all deployments
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
EXPORT_MODE=false
DEV_SERVER="${NEXAAS_DEV_SERVER:-}"  # e.g., user@dev.example.com:/path/to/nexaas

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
        --export) EXPORT_MODE=true; shift ;;
        *) error "Unknown option: $1" ;;
    esac
done

# Patterns for framework-contributable files
FRAMEWORK_PATTERNS=(
    "^framework/"
    "^engine/"
    "^dashboard/components/"
    "^dashboard/lib/"
    "^dashboard/app/"
    "^scripts/"
    "^docs/"
)

# Patterns to always exclude
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

# Sensitive data patterns
SENSITIVE_PATTERNS=(
    'sk-live-[a-zA-Z0-9]+'
    'sk-test-[a-zA-Z0-9]+'
    'sk-[a-zA-Z0-9]{20,}'
    'api[_-]?key\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'token\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'password\s*[:=]\s*["\x27][^\x27"]{4,}'
    'secret\s*[:=]\s*["\x27][a-zA-Z0-9_-]{16,}'
    'ghp_[a-zA-Z0-9]{36}'
    'gho_[a-zA-Z0-9]{36}'
    'xox[baprs]-[a-zA-Z0-9-]+'
)

# Customer-specific patterns
CUSTOMER_PATTERNS=(
    '\b[A-Z][a-z]+\s+(Corp|Inc|LLC|Ltd|Company|Co|Group|Holdings|Industries|Solutions|Services|Digital|Media|Agency|Consulting)\b'
    '@[a-z0-9-]+\.(com|io|co|net|org)'
    'hooks\.(slack|discord)\.com/[a-zA-Z0-9/_-]+'
)

SANITIZATION_ISSUES=()

# ============================================================================
# FUNCTIONS
# ============================================================================

detect_changes() {
    cd "$PROJECT_DIR"

    log "Detecting changes..."

    # Get changed files (staged and unstaged)
    local changed_files=$(git diff --name-only HEAD 2>/dev/null || git status --porcelain | awk '{print $2}')

    if [[ -z "$changed_files" ]]; then
        success "No changes detected"
        exit 0
    fi

    CONTRIBUTABLE_FILES=()
    EXCLUDED_FILES=()

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue

        local excluded=false
        for pattern in "${EXCLUDE_PATTERNS[@]}"; do
            if [[ "$file" == *"$pattern"* ]]; then
                excluded=true
                EXCLUDED_FILES+=("$file")
                break
            fi
        done
        [[ "$excluded" == true ]] && continue

        local is_framework=false
        for pattern in "${FRAMEWORK_PATTERNS[@]}"; do
            if [[ "$file" =~ $pattern ]]; then
                CONTRIBUTABLE_FILES+=("$file")
                is_framework=true
                break
            fi
        done

        if [[ "$is_framework" == false ]]; then
            EXCLUDED_FILES+=("$file")
        fi
    done <<< "$changed_files"

    echo ""
    echo "┌─────────────────────────────────────────┐"
    echo "│         CHANGES DETECTED                │"
    echo "└─────────────────────────────────────────┘"

    if [[ ${#CONTRIBUTABLE_FILES[@]} -gt 0 ]]; then
        echo ""
        success "Framework changes (will export):"
        for f in "${CONTRIBUTABLE_FILES[@]}"; do
            echo "    + $f"
        done
    fi

    if [[ ${#EXCLUDED_FILES[@]} -gt 0 ]]; then
        echo ""
        info "Customer-specific (excluded):"
        for f in "${EXCLUDED_FILES[@]}"; do
            echo "    - $f"
        done
    fi
    echo ""
}

check_sanitization() {
    log "Running sanitization checks..."
    echo ""

    for file in "${CONTRIBUTABLE_FILES[@]}"; do
        local filepath="$PROJECT_DIR/$file"
        [[ ! -f "$filepath" ]] && continue

        # Check sensitive patterns
        for pattern in "${SENSITIVE_PATTERNS[@]}"; do
            local matches=$(grep -noE "$pattern" "$filepath" 2>/dev/null | grep -vE '\$\{|example\.com|placeholder|your-.*-here|localhost' || true)
            if [[ -n "$matches" ]]; then
                SANITIZATION_ISSUES+=("$file")
                sanitize_warn "BLOCKED: $file"
                echo "$matches" | head -3 | sed 's/^/    /'
                echo ""
            fi
        done

        # Check customer patterns
        for pattern in "${CUSTOMER_PATTERNS[@]}"; do
            local matches=$(grep -noEi "$pattern" "$filepath" 2>/dev/null | grep -vE 'example\.com|placeholder|localhost' || true)
            if [[ -n "$matches" ]]; then
                SANITIZATION_ISSUES+=("$file")
                sanitize_warn "BLOCKED: $file"
                echo "$matches" | head -3 | sed 's/^/    /'
                echo ""
            fi
        done
    done

    if [[ ${#SANITIZATION_ISSUES[@]} -gt 0 ]]; then
        echo ""
        echo -e "${RED}╔══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${RED}║  SANITIZATION FAILED - FIX BEFORE EXPORTING                  ║${NC}"
        echo -e "${RED}╚══════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo "Replace customer-specific content with:"
        echo "  - API keys:  \${API_KEY} or 'your-api-key-here'"
        echo "  - URLs:      example.com or \${BASE_URL}"
        echo "  - Names:     Remove or use 'Acme Corp'"
        echo ""
        echo "Then re-run: bash scripts/contribute.sh --export"
        echo ""
        exit 1
    fi

    success "Sanitization passed"
}

export_patch() {
    cd "$PROJECT_DIR"

    local timestamp=$(date +%Y%m%d_%H%M%S)
    local hostname=$(hostname -s)
    local patch_dir="$PROJECT_DIR/exports"
    local patch_file="$patch_dir/nexaas-patch-${hostname}-${timestamp}.patch"

    mkdir -p "$patch_dir"

    log "Creating patch..."

    # Create patch from changes
    git diff HEAD -- "${CONTRIBUTABLE_FILES[@]}" > "$patch_file" 2>/dev/null || true

    # If no staged changes, try unstaged
    if [[ ! -s "$patch_file" ]]; then
        git diff -- "${CONTRIBUTABLE_FILES[@]}" > "$patch_file" 2>/dev/null || true
    fi

    # If still empty, create from untracked files
    if [[ ! -s "$patch_file" ]]; then
        for f in "${CONTRIBUTABLE_FILES[@]}"; do
            if [[ -f "$PROJECT_DIR/$f" ]]; then
                echo "--- /dev/null" >> "$patch_file"
                echo "+++ b/$f" >> "$patch_file"
                echo "@@ -0,0 +1,$(wc -l < "$PROJECT_DIR/$f") @@" >> "$patch_file"
                sed 's/^/+/' "$PROJECT_DIR/$f" >> "$patch_file"
            fi
        done
    fi

    if [[ ! -s "$patch_file" ]]; then
        error "Failed to create patch - no changes found"
    fi

    success "Patch created: $patch_file"
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  NEXT STEPS                                                  ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "1. Copy patch to your dev machine:"
    echo ""
    echo "   scp $patch_file user@dev-server:/path/to/nexaas/exports/"
    echo ""

    if [[ -n "$DEV_SERVER" ]]; then
        echo "   Or using configured dev server:"
        echo "   scp $patch_file $DEV_SERVER/exports/"
        echo ""
    fi

    echo "2. On dev machine, apply and push:"
    echo ""
    echo "   cd /path/to/nexaas"
    echo "   git checkout -b fix/description-here"
    echo "   git apply exports/$(basename "$patch_file")"
    echo "   git add -A && git commit -m 'Fix: description'"
    echo "   git push origin fix/description-here"
    echo "   gh pr create --fill"
    echo ""
    echo "3. After merge, update all deployments:"
    echo ""
    echo "   bash scripts/update-all.sh"
    echo ""
}

rsync_to_dev() {
    if [[ -z "$DEV_SERVER" ]]; then
        warn "NEXAAS_DEV_SERVER not set"
        echo ""
        echo "Set it to enable direct rsync:"
        echo "  export NEXAAS_DEV_SERVER=user@dev.example.com:/path/to/nexaas"
        echo ""
        return 1
    fi

    log "Syncing to dev server: $DEV_SERVER"

    for f in "${CONTRIBUTABLE_FILES[@]}"; do
        if [[ "$DRY_RUN" == true ]]; then
            info "[DRY-RUN] Would rsync: $f"
        else
            rsync -avz "$PROJECT_DIR/$f" "$DEV_SERVER/$f"
        fi
    done

    success "Files synced to dev server"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║     Nexaas Contribution Export           ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    cd "$PROJECT_DIR"

    if [[ ! -d ".git" ]]; then
        error "Not a git repository"
    fi

    detect_changes

    if [[ ${#CONTRIBUTABLE_FILES[@]} -eq 0 ]]; then
        info "No framework changes to contribute"
        exit 0
    fi

    check_sanitization

    if [[ "$EXPORT_MODE" == true ]]; then
        export_patch
    else
        echo ""
        echo "Run with --export to create a patch file:"
        echo "  bash scripts/contribute.sh --export"
        echo ""
        echo "Or set NEXAAS_DEV_SERVER and sync directly:"
        echo "  export NEXAAS_DEV_SERVER=user@dev:/path/to/nexaas"
        echo "  bash scripts/contribute.sh --export"
        echo ""
    fi
}

main "$@"
