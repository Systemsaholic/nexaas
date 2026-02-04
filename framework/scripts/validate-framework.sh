#!/usr/bin/env bash
# Validate framework/ directory for business-specific content.
# Exit code = number of violations found.

set -euo pipefail

FRAMEWORK_DIR="${1:-framework}"
VIOLATIONS=0

echo "Validating $FRAMEWORK_DIR ..."

# Check for API keys / secrets
if grep -rn --include='*.yaml' --include='*.md' --include='*.json' \
    -E '(sk-[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*["\x27][^{][^"\x27]+)' "$FRAMEWORK_DIR" 2>/dev/null; then
    echo "FAIL: Possible API key or secret found"
    VIOLATIONS=$((VIOLATIONS + 1))
fi

# Check for real email addresses (ignore placeholders)
if grep -rn --include='*.yaml' --include='*.md' --include='*.json' \
    -E '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' "$FRAMEWORK_DIR" 2>/dev/null \
    | grep -v 'example\.com' | grep -v '{{' | grep -v 'noreply@'; then
    echo "FAIL: Real email address found"
    VIOLATIONS=$((VIOLATIONS + 1))
fi

# Check for hardcoded IPs (ignore localhost)
if grep -rn --include='*.yaml' --include='*.md' --include='*.json' \
    -E '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$FRAMEWORK_DIR" 2>/dev/null \
    | grep -v '127\.0\.0\.1' | grep -v '0\.0\.0\.0' | grep -v 'localhost'; then
    echo "FAIL: Hardcoded IP address found"
    VIOLATIONS=$((VIOLATIONS + 1))
fi

# Check for private paths
if grep -rn --include='*.yaml' --include='*.md' --include='*.json' \
    -E '(/home/|/Users/|C:\\Users\\)' "$FRAMEWORK_DIR" 2>/dev/null; then
    echo "FAIL: Private filesystem path found"
    VIOLATIONS=$((VIOLATIONS + 1))
fi

if [ "$VIOLATIONS" -eq 0 ]; then
    echo "PASS: No violations found"
else
    echo "FAIL: $VIOLATIONS violation(s) found"
fi

exit "$VIOLATIONS"
