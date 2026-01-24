#!/usr/bin/env bash
# Start the backend API server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Load environment if available
if [[ -f .env ]]; then
    source .env
fi

PORT="${PORT:-3000}"
DATA_DIR="${DATA_DIR:-../data}"

echo "Starting backend on http://localhost:$PORT"
cd backend

# Use cargo-watch for hot reload if available, otherwise regular cargo run
if command -v cargo-watch &>/dev/null; then
    echo "  (hot reload enabled via cargo-watch)"
    DATA_DIR="$DATA_DIR" PORT="$PORT" cargo watch -x "run --release"
else
    DATA_DIR="$DATA_DIR" PORT="$PORT" cargo run --release
fi
