#!/usr/bin/env bash
# Start a GBL example instance by name.
# Usage: ./scripts/start-example.sh cgdc
#        ./scripts/start-example.sh gnomad
#        ./scripts/start-example.sh singapore
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE="${1:?Usage: start-example.sh <example-name>}"
EXAMPLE_DIR="$PROJECT_ROOT/examples/$EXAMPLE"
CONFIG="$EXAMPLE_DIR/gbl.toml"

if [ ! -f "$CONFIG" ]; then
  echo "Error: $CONFIG not found"
  echo "Available examples:"
  ls -1 "$PROJECT_ROOT/examples/"
  exit 1
fi

# Parse ports from the TOML config
PORT=$(grep '^port' "$CONFIG" | head -1 | sed 's/.*= *//')
VITE_PORT=$(grep '^vite_port' "$CONFIG" | head -1 | sed 's/.*= *//')

if [ -z "$PORT" ] || [ -z "$VITE_PORT" ]; then
  echo "Error: [server] port and vite_port must be set in $CONFIG"
  exit 1
fi

echo "Starting $EXAMPLE instance:"
echo "  Backend:  http://localhost:$PORT"
echo "  Frontend: http://localhost:$VITE_PORT"
echo "  Config:   $CONFIG"
echo ""

# Kill any existing processes on these ports
lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
lsof -ti :"$VITE_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

# Start backend
cd "$PROJECT_ROOT"
PORT="$PORT" nohup backend/target/release/backend serve --config "$CONFIG" \
  > "/tmp/gbl-$EXAMPLE-backend.log" 2>&1 &
BACKEND_PID=$!
echo "  Backend PID: $BACKEND_PID (log: /tmp/gbl-$EXAMPLE-backend.log)"

# Wait for backend to start
sleep 5

# Start frontend
cd "$PROJECT_ROOT/frontend"
VITE_API_URL="http://localhost:$PORT" nohup npx vite --port "$VITE_PORT" \
  > "/tmp/gbl-$EXAMPLE-frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "  Frontend PID: $FRONTEND_PID (log: /tmp/gbl-$EXAMPLE-frontend.log)"

echo ""
echo "Open http://localhost:$VITE_PORT in your browser."
echo "To stop: kill $BACKEND_PID $FRONTEND_PID"
