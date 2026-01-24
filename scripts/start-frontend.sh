#!/usr/bin/env bash
# Start the Vite dev server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Load environment if available
if [[ -f .env ]]; then
    . ./.env
fi

VITE_PORT="${VITE_PORT:-5173}"
VITE_API_URL="${VITE_API_URL:-http://localhost:3000}"

echo "Starting frontend on http://localhost:$VITE_PORT"
echo "  API URL: $VITE_API_URL"
cd frontend && VITE_PORT="$VITE_PORT" VITE_API_URL="$VITE_API_URL" pnpm dev
