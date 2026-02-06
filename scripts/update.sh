#!/usr/bin/env bash
#
# Nexaas Smart Auto-Update Script
# Detects change types and applies minimal required updates
#
# Usage:
#   bash scripts/update.sh [--docker|--vps] [--force] [--no-backup] [--full]
#
# Options:
#   --docker     Force Docker update mode
#   --vps        Force VPS update mode
#   --force      Skip confirmation prompts
#   --no-backup  Skip database backup
#   --full       Force full rebuild regardless of changes
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Defaults
MODE=""
FORCE=false
BACKUP=true
FULL_REBUILD=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change detection flags
NEEDS_ENGINE_RESTART=false
NEEDS_DASHBOARD_REBUILD=false
NEEDS_ENGINE_DEPS=false
NEEDS_DASHBOARD_DEPS=false
CONTENT_ONLY=true

log() { echo -e "${BLUE}[UPDATE]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --docker) MODE="docker"; shift ;;
        --vps) MODE="vps"; shift ;;
        --force) FORCE=true; shift ;;
        --no-backup) BACKUP=false; shift ;;
        --full) FULL_REBUILD=true; shift ;;
        *) error "Unknown option: $1" ;;
    esac
done

# Auto-detect mode if not specified
detect_mode() {
    if [[ -n "$MODE" ]]; then
        return
    fi

    if docker compose ps &>/dev/null && docker compose ps | grep -q "nexaas"; then
        MODE="docker"
    elif systemctl is-active --quiet nexaas-engine 2>/dev/null; then
        MODE="vps"
    elif [[ -f "$PROJECT_DIR/docker-compose.yml" ]] && command -v docker &>/dev/null; then
        MODE="docker"
    elif [[ -f "$PROJECT_DIR/engine/server.py" ]]; then
        MODE="vps"
    else
        error "Could not detect deployment mode. Use --docker or --vps flag."
    fi

    log "Detected deployment mode: $MODE"
}

# Get current version (git commit)
get_current_version() {
    cd "$PROJECT_DIR"
    git rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

# Analyze what files changed and determine required actions
analyze_changes() {
    cd "$PROJECT_DIR"

    log "Analyzing incoming changes..."

    # Get list of changed files
    local changed_files=$(git diff --name-only HEAD..origin/main)

    if [[ -z "$changed_files" ]]; then
        return
    fi

    # Categorize changes
    local content_patterns=(
        "\.md$"
        "^framework/agents/"
        "^framework/skills/"
        "^framework/playbooks/"
        "^framework/templates/"
        "^framework/mcp-servers/"
        "^workspace/"
        "^examples/"
        "^templates/"
        "\.claude/commands/"
        "registries/.*\.yaml$"
        "agents/.*/prompt\.md$"
        "agents/.*/config\.yaml$"
    )

    local engine_code_patterns=(
        "^engine/.*\.py$"
        "^engine/api/"
        "^engine/orchestrator/"
        "^engine/db/"
    )

    local dashboard_code_patterns=(
        "^dashboard/.*\.tsx?$"
        "^dashboard/.*\.jsx?$"
        "^dashboard/components/"
        "^dashboard/lib/"
        "^dashboard/app/"
    )

    local engine_dep_patterns=(
        "^engine/requirements\.txt$"
    )

    local dashboard_dep_patterns=(
        "^dashboard/package\.json$"
        "^dashboard/package-lock\.json$"
    )

    # Check each file
    while IFS= read -r file; do
        [[ -z "$file" ]] && continue

        # Check engine dependencies
        for pattern in "${engine_dep_patterns[@]}"; do
            if [[ "$file" =~ $pattern ]]; then
                NEEDS_ENGINE_DEPS=true
                NEEDS_ENGINE_RESTART=true
                CONTENT_ONLY=false
            fi
        done

        # Check dashboard dependencies
        for pattern in "${dashboard_dep_patterns[@]}"; do
            if [[ "$file" =~ $pattern ]]; then
                NEEDS_DASHBOARD_DEPS=true
                NEEDS_DASHBOARD_REBUILD=true
                CONTENT_ONLY=false
            fi
        done

        # Check engine code
        for pattern in "${engine_code_patterns[@]}"; do
            if [[ "$file" =~ $pattern ]]; then
                NEEDS_ENGINE_RESTART=true
                CONTENT_ONLY=false
            fi
        done

        # Check dashboard code
        for pattern in "${dashboard_code_patterns[@]}"; do
            if [[ "$file" =~ $pattern ]]; then
                NEEDS_DASHBOARD_REBUILD=true
                CONTENT_ONLY=false
            fi
        done

    done <<< "$changed_files"

    # Docker/compose changes always need full rebuild
    if echo "$changed_files" | grep -qE "(Dockerfile|docker-compose\.yml)"; then
        NEEDS_ENGINE_RESTART=true
        NEEDS_DASHBOARD_REBUILD=true
        CONTENT_ONLY=false
    fi
}

# Display update plan
show_update_plan() {
    echo ""
    echo "┌─────────────────────────────────────────┐"
    echo "│           UPDATE PLAN                   │"
    echo "└─────────────────────────────────────────┘"
    echo ""

    if [[ "$FULL_REBUILD" == true ]]; then
        info "Full rebuild requested (--full flag)"
        NEEDS_ENGINE_RESTART=true
        NEEDS_DASHBOARD_REBUILD=true
        NEEDS_ENGINE_DEPS=true
        NEEDS_DASHBOARD_DEPS=true
        CONTENT_ONLY=false
    fi

    if [[ "$CONTENT_ONLY" == true ]]; then
        success "Content-only update detected"
        echo ""
        echo "  Changes include:"
        echo "    - Prompts, skills, or commands"
        echo "    - Agent configurations"
        echo "    - MCP server configs"
        echo "    - Documentation"
        echo ""
        echo "  Action: Pull changes only (no restart needed)"
        echo "  Files are picked up automatically on next request"
        echo ""
    else
        echo "  Actions required:"
        echo ""
        if [[ "$NEEDS_ENGINE_DEPS" == true ]]; then
            echo "    [x] Install Python dependencies"
        fi
        if [[ "$NEEDS_DASHBOARD_DEPS" == true ]]; then
            echo "    [x] Install Node.js dependencies"
        fi
        if [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
            echo "    [x] Rebuild dashboard"
        fi
        if [[ "$NEEDS_ENGINE_RESTART" == true ]]; then
            echo "    [x] Restart engine"
        fi
        if [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
            echo "    [x] Restart dashboard"
        fi
        echo ""
    fi
}

# Check for updates
check_updates() {
    cd "$PROJECT_DIR"

    log "Fetching latest changes..."
    git fetch origin main --quiet

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)

    if [[ "$LOCAL" == "$REMOTE" ]]; then
        success "Already up to date ($(get_current_version))"
        exit 0
    fi

    # Show what's new
    echo ""
    log "New commits available:"
    git log --oneline HEAD..origin/main | head -10
    COMMIT_COUNT=$(git rev-list --count HEAD..origin/main)
    if [[ $COMMIT_COUNT -gt 10 ]]; then
        echo "  ... and $((COMMIT_COUNT - 10)) more"
    fi

    # Analyze changes
    analyze_changes
    show_update_plan
}

# Backup database
backup_database() {
    if [[ "$BACKUP" != true ]]; then
        warn "Skipping backup (--no-backup)"
        return
    fi

    # Only backup if we're doing more than content updates
    if [[ "$CONTENT_ONLY" == true ]]; then
        info "Skipping backup (content-only update)"
        return
    fi

    local backup_dir="$PROJECT_DIR/backups"
    local timestamp=$(date +%Y%m%d_%H%M%S)

    mkdir -p "$backup_dir"

    if [[ "$MODE" == "docker" ]]; then
        if docker compose exec -T engine test -f /app/data/nexaas.db 2>/dev/null; then
            log "Backing up database from Docker..."
            docker compose cp engine:/app/data/nexaas.db "$backup_dir/nexaas_$timestamp.db"
            success "Database backed up to backups/nexaas_$timestamp.db"
        fi
    else
        local db_path="${DATABASE_PATH:-$PROJECT_DIR/engine/data/nexaas.db}"
        if [[ -f "$db_path" ]]; then
            log "Backing up database..."
            cp "$db_path" "$backup_dir/nexaas_$timestamp.db"
            success "Database backed up to backups/nexaas_$timestamp.db"
        fi
    fi

    # Keep only last 10 backups
    ls -t "$backup_dir"/nexaas_*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
}

# Confirm update
confirm_update() {
    if [[ "$FORCE" == true ]]; then
        return
    fi

    echo -n "Proceed with update? [y/N] "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log "Update cancelled"
        exit 0
    fi
}

# Pull latest changes
pull_changes() {
    cd "$PROJECT_DIR"
    log "Pulling latest changes..."
    git pull origin main --quiet
    success "Code updated to $(get_current_version)"
}

# Update Docker deployment
update_docker() {
    cd "$PROJECT_DIR"

    if [[ "$CONTENT_ONLY" == true ]]; then
        pull_changes
        success "Content update complete - changes are live"
        return
    fi

    if [[ "$NEEDS_ENGINE_RESTART" == true ]] || [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Stopping services..."
        docker compose stop
    fi

    pull_changes

    if [[ "$NEEDS_ENGINE_DEPS" == true ]] || [[ "$NEEDS_DASHBOARD_DEPS" == true ]] || [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Rebuilding containers..."
        docker compose build
    fi

    if [[ "$NEEDS_ENGINE_RESTART" == true ]] || [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Starting services..."
        docker compose up -d

        log "Waiting for health check..."
        sleep 5

        local retries=30
        while [[ $retries -gt 0 ]]; do
            if curl -sf http://localhost:8400/api/health &>/dev/null; then
                success "Engine is healthy"
                break
            fi
            retries=$((retries - 1))
            sleep 2
        done

        if [[ $retries -eq 0 ]]; then
            error "Engine failed to start. Check logs: docker compose logs engine"
        fi
    fi
}

# Update VPS deployment
update_vps() {
    cd "$PROJECT_DIR"

    if [[ "$CONTENT_ONLY" == true ]]; then
        pull_changes
        success "Content update complete - changes are live"
        return
    fi

    # Stop services if needed
    if [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Stopping dashboard..."
        sudo systemctl stop nexaas-dashboard 2>/dev/null || true
    fi

    if [[ "$NEEDS_ENGINE_RESTART" == true ]]; then
        log "Stopping engine..."
        sudo systemctl stop nexaas-engine 2>/dev/null || true
    fi

    pull_changes

    # Update Python dependencies if needed
    if [[ "$NEEDS_ENGINE_DEPS" == true ]]; then
        log "Updating Python dependencies..."
        cd "$PROJECT_DIR/engine"
        if [[ -f ".venv/bin/activate" ]]; then
            source .venv/bin/activate
            pip install -r requirements.txt --quiet
            deactivate
        fi
    fi

    # Update Node dependencies and rebuild dashboard if needed
    if [[ "$NEEDS_DASHBOARD_DEPS" == true ]]; then
        log "Updating Node.js dependencies..."
        cd "$PROJECT_DIR/dashboard"
        npm install --silent
    fi

    if [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Rebuilding dashboard..."
        cd "$PROJECT_DIR/dashboard"
        npm run build
    fi

    # Restart services
    if [[ "$NEEDS_ENGINE_RESTART" == true ]]; then
        log "Starting engine..."
        sudo systemctl start nexaas-engine

        log "Waiting for health check..."
        sleep 3

        local retries=30
        local engine_port="${PORT:-8400}"
        while [[ $retries -gt 0 ]]; do
            if curl -sf "http://localhost:$engine_port/api/health" &>/dev/null; then
                success "Engine is healthy"
                break
            fi
            retries=$((retries - 1))
            sleep 2
        done

        if [[ $retries -eq 0 ]]; then
            error "Engine failed to start. Check logs: journalctl -u nexaas-engine -n 50"
        fi
    fi

    if [[ "$NEEDS_DASHBOARD_REBUILD" == true ]]; then
        log "Starting dashboard..."
        sudo systemctl start nexaas-dashboard
    fi
}

# Main
main() {
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║       Nexaas Smart Auto-Update           ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    cd "$PROJECT_DIR"

    # Ensure we're in a git repo
    if [[ ! -d ".git" ]]; then
        error "Not a git repository. Run from the nexaas project root."
    fi

    detect_mode

    log "Current version: $(get_current_version)"

    check_updates
    confirm_update
    backup_database

    echo ""
    if [[ "$MODE" == "docker" ]]; then
        update_docker
    else
        update_vps
    fi

    echo ""
    success "Update complete! Now running $(get_current_version)"

    if [[ "$CONTENT_ONLY" == true ]]; then
        info "Content changes are available immediately"
    fi

    echo ""
}

main "$@"
