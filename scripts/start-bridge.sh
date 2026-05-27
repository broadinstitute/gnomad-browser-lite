#!/usr/bin/env bash
# Start the CopilotKit <-> MCP bridge server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Load environment if available
if [[ -f .env ]]; then
    . ./.env
fi

BRIDGE_PORT="${BRIDGE_PORT:-4111}"
CONFIG="${GBL_CONFIG:-examples/gnomad/gbl.toml}"

# Path to the Rust backend binary
BACKEND_BIN="${BACKEND_BIN:-$(cd backend && cargo metadata --format-version 1 --no-deps 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])" 2>/dev/null)/release/backend}"

# Fall back to cargo run if binary not found
if [[ ! -f "$BACKEND_BIN" ]]; then
    echo "Backend binary not found at $BACKEND_BIN"
    echo "Building backend..."
    (cd backend && cargo build --release)
    BACKEND_BIN="$(cd backend && cargo metadata --format-version 1 --no-deps | python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])")/release/backend"
fi

export MCP_COMMAND="$BACKEND_BIN"
export MCP_ARGS="--config $CONFIG mcp stdio"
export PORT="$BRIDGE_PORT"

echo "Starting CopilotKit bridge on http://localhost:$BRIDGE_PORT"
echo "  MCP command: $MCP_COMMAND $MCP_ARGS"

BRIDGE_DIR="$PROJECT_ROOT/../genohype/ui/packages/bridge"

cd "$BRIDGE_DIR"

# Install deps if needed
if [[ ! -d node_modules ]]; then
    echo "  Installing bridge dependencies..."
    npm install
fi

# Run with tsx for development
npx tsx src/server.ts
