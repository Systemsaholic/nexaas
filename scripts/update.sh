#!/usr/bin/env bash
#
# Nexaas Auto-Update Script
# Updates deployed instances (VPS or Docker) to the latest version
#
# Usage:
#   bash scripts/update.sh [--docker|--vps] [--force] [--no-backup]
#
# Options:
#   --docker     Force Docker update mode
#   --vps        Force VPS update mode
#   --force      Skip confirmation prompts
#   --no-backup  Skip database backup
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Defaults
MODE=""
FORCE=false
BACKUP=true
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

log() { echo -e "${BLUE}[UPDATE]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --docker) MODE="docker"; shift ;;
        --vps) MODE="vps"; shift ;;
        --force) FORCE=true; shift ;;
        --no-backup) BACKUP=false; shift ;;
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
    echo ""
}

# Backup database
backup_database() {
    if [[ "$BACKUP" != true ]]; then
        warn "Skipping backup (--no-backup)"
        return
    fi

    local db_path=""
    local backup_dir="$PROJECT_DIR/backups"
    local timestamp=$(date +%Y%m%d_%H%M%S)

    mkdir -p "$backup_dir"

    if [[ "$MODE" == "docker" ]]; then
        # Docker: copy from volume or container
        if docker compose exec -T engine test -f /app/data/nexaas.db 2>/dev/null; then
            log "Backing up database from Docker..."
            docker compose cp engine:/app/data/nexaas.db "$backup_dir/nexaas_$timestamp.db"
            success "Database backed up to backups/nexaas_$timestamp.db"
        fi
    else
        # VPS: direct file copy
        db_path="${DATABASE_PATH:-$PROJECT_DIR/engine/data/nexaas.db}"
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

# Update Docker deployment
update_docker() {
    cd "$PROJECT_DIR"

    log "Stopping services..."
    docker compose stop

    log "Pulling latest changes..."
    git pull origin main

    log "Rebuilding containers..."
    docker compose build --no-cache

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
}

# Update VPS deployment
update_vps() {
    cd "$PROJECT_DIR"

    log "Stopping services..."
    sudo systemctl stop nexaas-dashboard 2>/dev/null || true
    sudo systemctl stop nexaas-engine 2>/dev/null || true

    log "Pulling latest changes..."
    git pull origin main

    # Update Python dependencies
    log "Updating Python dependencies..."
    cd "$PROJECT_DIR/engine"
    if [[ -f ".venv/bin/activate" ]]; then
        source .venv/bin/activate
        pip install -r requirements.txt --quiet
        deactivate
    fi

    # Update Node dependencies and rebuild dashboard
    log "Updating dashboard..."
    cd "$PROJECT_DIR/dashboard"
    npm install --silent
    npm run build

    log "Starting services..."
    sudo systemctl start nexaas-engine
    sudo systemctl start nexaas-dashboard

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
}

# Main
main() {
    echo ""
    echo "=================================="
    echo "  Nexaas Auto-Update"
    echo "=================================="
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
    echo ""
}

main "$@"
