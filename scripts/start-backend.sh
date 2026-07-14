#!/usr/bin/env bash
# Start the backend API server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Load environment if available
if [[ -f .env ]]; then
    . ./.env
fi

PORT="${PORT:-3000}"
DATA_DIR="${DATA_DIR:-../data}"

# Optional gbl.toml config. When GBL_CONFIG is unset the backend falls back to
# its zero-config default (Hail backend on the public gnomAD GCS tables). Set
# GBL_CONFIG to an absolute path or one relative to the project root, e.g.
#   GBL_CONFIG=examples/gnomad/gbl.toml pnpm start
# (matches start-bridge.sh, which reads the same variable).
CONFIG_ARGS=()
if [[ -n "${GBL_CONFIG:-}" ]]; then
    CONFIG_PATH="$GBL_CONFIG"
    [[ "$CONFIG_PATH" != /* ]] && CONFIG_PATH="$PROJECT_ROOT/$CONFIG_PATH"
    CONFIG_ARGS=(--config "$CONFIG_PATH")
    echo "  Using config: $CONFIG_PATH"
fi

echo "Starting backend on http://localhost:$PORT"
cd backend

# Use cargo-watch for hot reload if available, otherwise regular cargo run
if command -v cargo-watch &>/dev/null; then
    echo "  (hot reload enabled via cargo-watch)"
    DATA_DIR="$DATA_DIR" PORT="$PORT" cargo watch -x "run --release -- ${CONFIG_ARGS[*]} serve"
else
    echo "  (tip: install cargo-watch for hot reload: cargo install cargo-watch)"
    DATA_DIR="$DATA_DIR" PORT="$PORT" cargo run --release -- "${CONFIG_ARGS[@]}" serve
fi
