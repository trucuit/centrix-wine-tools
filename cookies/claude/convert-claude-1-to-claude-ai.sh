#!/usr/bin/env bash
# Thin wrapper → scripts/convert-snapshot.sh (multi-service convert).
# Kept for backward compatibility with older docs/paths.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
exec "$REPO_ROOT/scripts/convert-snapshot.sh" claude-1 --full "$@"
