#!/usr/bin/env bash
#
# Nexaas Update All Deployments
# Runs update.sh on all configured customer deployments
#
# Usage:
#   bash scripts/update-all.sh [--dry-run] [--parallel]
#
# Configuration:
#   Create ~/.nexaas/deployments.conf with one server per line:
#     user@customer-a.example.com:/opt/nexaas
#     user@customer-b.example.com:/opt/nexaas
#     user@192.168.1.100:/home/nexaas/app
#
#   Or set NEXAAS_DEPLOYMENTS environment variable:
#     export NEXAAS_DEPLOYMENTS="user@a:/path user@b:/path"
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

DRY_RUN=false
PARALLEL=false
CONFIG_FILE="${HOME}/.nexaas/deployments.conf"

log() { echo -e "${BLUE}[UPDATE-ALL]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --parallel) PARALLEL=true; shift ;;
        --config) CONFIG_FILE="$2"; shift 2 ;;
        *) error "Unknown option: $1"; exit 1 ;;
    esac
done

# Load deployments
load_deployments() {
    DEPLOYMENTS=()

    # From environment variable
    if [[ -n "$NEXAAS_DEPLOYMENTS" ]]; then
        for server in $NEXAAS_DEPLOYMENTS; do
            DEPLOYMENTS+=("$server")
        done
    fi

    # From config file
    if [[ -f "$CONFIG_FILE" ]]; then
        while IFS= read -r line; do
            # Skip comments and empty lines
            [[ -z "$line" || "$line" =~ ^# ]] && continue
            DEPLOYMENTS+=("$line")
        done < "$CONFIG_FILE"
    fi

    if [[ ${#DEPLOYMENTS[@]} -eq 0 ]]; then
        warn "No deployments configured"
        echo ""
        echo "Configure deployments in one of these ways:"
        echo ""
        echo "1. Create $CONFIG_FILE:"
        echo "   mkdir -p ~/.nexaas"
        echo "   cat > ~/.nexaas/deployments.conf << 'EOF'"
        echo "   user@customer-a.example.com:/opt/nexaas"
        echo "   user@customer-b.example.com:/opt/nexaas"
        echo "   EOF"
        echo ""
        echo "2. Set environment variable:"
        echo "   export NEXAAS_DEPLOYMENTS=\"user@a:/path user@b:/path\""
        echo ""
        exit 1
    fi
}

update_server() {
    local deployment="$1"
    local server="${deployment%%:*}"
    local path="${deployment#*:}"

    echo ""
    log "Updating: $server"
    info "Path: $path"

    if [[ "$DRY_RUN" == true ]]; then
        info "[DRY-RUN] Would run: ssh $server 'cd $path && bash scripts/update.sh --force'"
        return 0
    fi

    # Run update script on remote server
    if ssh -o ConnectTimeout=10 "$server" "cd $path && bash scripts/update.sh --force" 2>&1; then
        success "Updated: $server"
        return 0
    else
        error "Failed: $server"
        return 1
    fi
}

update_sequential() {
    local failed=0

    for deployment in "${DEPLOYMENTS[@]}"; do
        if ! update_server "$deployment"; then
            failed=$((failed + 1))
        fi
    done

    return $failed
}

update_parallel() {
    local pids=()
    local results=()

    for deployment in "${DEPLOYMENTS[@]}"; do
        update_server "$deployment" &
        pids+=($!)
    done

    local failed=0
    for pid in "${pids[@]}"; do
        if ! wait "$pid"; then
            failed=$((failed + 1))
        fi
    done

    return $failed
}

main() {
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║     Nexaas Update All Deployments        ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        warn "Running in dry-run mode"
    fi

    load_deployments

    log "Found ${#DEPLOYMENTS[@]} deployment(s):"
    for d in "${DEPLOYMENTS[@]}"; do
        echo "    - $d"
    done

    echo ""
    echo -n "Proceed with update? [y/N] "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        log "Cancelled"
        exit 0
    fi

    local failed=0
    if [[ "$PARALLEL" == true ]]; then
        log "Updating in parallel..."
        update_parallel || failed=$?
    else
        log "Updating sequentially..."
        update_sequential || failed=$?
    fi

    echo ""
    echo "════════════════════════════════════════════"
    if [[ $failed -eq 0 ]]; then
        success "All ${#DEPLOYMENTS[@]} deployments updated successfully"
    else
        error "$failed of ${#DEPLOYMENTS[@]} deployments failed"
        exit 1
    fi
}

main "$@"
