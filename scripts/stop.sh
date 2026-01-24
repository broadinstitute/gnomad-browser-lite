#!/usr/bin/env bash
# Stop running servers for this project/worktree
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Load environment if available
if [[ -f .env ]]; then
    . ./.env
fi

PORT="${PORT:-3000}"
VITE_PORT="${VITE_PORT:-5173}"

echo "Stopping servers on ports $PORT and $VITE_PORT..."

# Kill processes on these ports
lsof -ti :"$PORT" :"$VITE_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true

echo "Done."
