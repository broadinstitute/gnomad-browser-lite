#!/usr/bin/env bash
# Setup script for gnomAD Browser Lite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default values
WORKTREE_NAME=""
WORKTREE_PATH=""
WORKTREE_BRANCH=""
INTERVALS_FILE="${INTERVALS_FILE:-data/test_intervals.json}"
SKIP_DATA="${SKIP_DATA:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"
FROM_MAIN="${FROM_MAIN:-false}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Setup gnomAD Browser Lite with data, builds, and port configuration.

Options:
    --worktree-name NAME    Name for unique port generation
    --create-worktree PATH  Create a new git worktree at PATH
    --branch BRANCH         Branch for new worktree (default: new branch from HEAD)
    --from-main             Copy parquet data from main (skip slow export)
    --intervals FILE        Intervals file for data export (default: data/test_intervals.json)
    --skip-data             Skip parquet data export
    --skip-build            Skip backend/frontend builds
    -h, --help              Show this help

Without --worktree-name, uses default ports (3000/5173).
With --worktree-name, generates unique ports based on the name hash.

Examples:
    ./scripts/setup.sh                                      # Main project setup
    ./scripts/setup.sh --worktree-name my-wt                # Setup with unique ports
    ./scripts/setup.sh --create-worktree ../my-feature      # Create worktree and setup
    ./scripts/setup.sh --create-worktree ../my-feature --from-main  # Fast: copy from main
    ./scripts/setup.sh --create-worktree ~/wt/fix --branch fix-bug
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --worktree-name) WORKTREE_NAME="$2"; shift 2 ;;
        --create-worktree) WORKTREE_PATH="$2"; shift 2 ;;
        --branch) WORKTREE_BRANCH="$2"; shift 2 ;;
        --intervals) INTERVALS_FILE="$2"; shift 2 ;;
        --skip-data) SKIP_DATA=true; shift ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        --from-main) FROM_MAIN=true; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift ;;  # Ignore -- separator from pnpm
        *) echo "Unknown option: $1"; usage; exit 1 ;;
    esac
done

# Create worktree if requested
if [[ -n "$WORKTREE_PATH" ]]; then
    # Convert to absolute path (works on macOS and Linux)
    if [[ "$WORKTREE_PATH" != /* ]]; then
        WORKTREE_PATH="$(pwd)/$WORKTREE_PATH"
    fi
    WORKTREE_NAME="${WORKTREE_NAME:-$(basename "$WORKTREE_PATH")}"
    WORKTREE_BRANCH="${WORKTREE_BRANCH:-$WORKTREE_NAME}"

    echo "Creating git worktree..."
    echo "  Path: $WORKTREE_PATH"
    echo "  Branch: $WORKTREE_BRANCH"
    echo ""

    cd "$MAIN_PROJECT"
    git worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_PATH"

    PROJECT_ROOT="$WORKTREE_PATH"
else
    PROJECT_ROOT="$MAIN_PROJECT"
fi

cd "$PROJECT_ROOT"

# Preflight: the backend and frontend depend on sibling repos by path
# (backend/Cargo.toml -> ../../genohype/*, frontend/package.json -> ../../genohype/ui,
# and optional ../../fastVEP/crates/* which Cargo resolves even with `vep` off).
# Fail loud with the fix instead of the cryptic path-resolution error a missing
# sibling (or the wrong fastVEP branch) produces.
preflight_siblings() {
    local parent missing=0
    parent="$(cd "$PROJECT_ROOT/.." && pwd)"

    if [[ ! -d "$parent/genohype/core" ]]; then
        echo "  MISSING: $parent/genohype  (backend crates + frontend assistant-ui)"
        echo "    git clone ssh://git@github.com/broadinstitute/genohype.git \"$parent/genohype\""
        missing=1
    fi
    # fastVEP must be the integration fork/branch: the upstream Huang-lab default
    # branch lacks fastvep-loftee and Cargo will fail to resolve the optional dep.
    if [[ ! -f "$parent/fastVEP/crates/fastvep-loftee/Cargo.toml" ]]; then
        echo "  MISSING: $parent/fastVEP  (needs the fastvep-loftee crate)"
        echo "    git clone ssh://git@github.com/mattsolo1/fastVEP.git \"$parent/fastVEP\""
        echo "    (cd \"$parent/fastVEP\" && git checkout genohype-integration)"
        missing=1
    fi

    if [[ "$missing" == "1" ]]; then
        echo ""
        echo "ERROR: required sibling repo(s) missing — clone them beside gnomad-browser-lite"
        echo "       and re-run setup. See docs/qc-methods-team-onboarding.md §0."
        exit 1
    fi
    echo "  Sibling repos OK: genohype, fastVEP"
}

# Preflight: the backend links a DuckDB library at build time (a legacy query
# backend). On macOS the Homebrew lib dir is hard-wired in backend/.cargo/config.toml;
# on Linux the system lib paths are searched. With no library present the build dies
# with a cryptic linker error, so check up front and fail loud with the fix — same as
# the sibling-repo check above. (`--features bundled` compiles DuckDB from source and
# needs no system library; see docs Prerequisites.)
preflight_duckdb() {
    local found=""
    # nullglob so unmatched patterns disappear instead of surviving literally (a plain
    # `ls a b` returns non-zero if ANY arg is missing, which false-negatives here).
    shopt -s nullglob
    local libs=(
        /opt/homebrew/opt/duckdb/lib/libduckdb.* /opt/homebrew/lib/libduckdb.*
        /usr/local/opt/duckdb/lib/libduckdb.*    /usr/local/lib/libduckdb.*
        /usr/lib/libduckdb.*                     /usr/lib/*/libduckdb.*
    )
    shopt -u nullglob
    (( ${#libs[@]} > 0 )) && found="${libs[0]}"

    if [[ -z "$found" ]]; then
        echo "  MISSING: DuckDB library (the backend links it at build time)"
        echo "    brew install duckdb        # macOS"
        echo "    (or build without a system library: add --features bundled)"
        echo ""
        echo "ERROR: no DuckDB library found — install it (or use --features bundled)"
        echo "       and re-run setup. See docs/qc-methods-team-onboarding.md Prerequisites."
        exit 1
    fi
    echo "  DuckDB library OK: $found"
}

echo "Checking sibling repos..."
preflight_siblings

if [[ -n "$WORKTREE_NAME" ]]; then
    echo "Setting up worktree: $WORKTREE_NAME"
else
    echo "Setting up gnomAD Browser Lite"
fi
echo "  Project root: $PROJECT_ROOT"
echo ""

# Copy data from main if requested (fast worktree setup)
if [[ "$FROM_MAIN" == "true" && "$PROJECT_ROOT" != "$MAIN_PROJECT" ]]; then
    echo "Copying data from main..."
    mkdir -p data
    if cp "$MAIN_PROJECT"/data/*.parquet data/ 2>/dev/null; then
        echo "  Copied parquet files"
        SKIP_DATA=true
    else
        echo "  No parquet files in main yet, will export"
    fi
fi

# Export parquet data
if [[ "$SKIP_DATA" != "true" ]]; then
    if [[ ! -f data/variants.parquet ]]; then
        echo "Exporting variants from gnomAD..."
        hail-decoder export parquet \
            --intervals-file "$INTERVALS_FILE" \
            "gs://gcp-public-data--gnomad/release/4.1/ht/browser/gnomad.browser.v4.1.sites.ht" \
            data/variants.parquet
    else
        echo "variants.parquet already exists, skipping"
    fi

    if [[ ! -f data/genes.parquet ]]; then
        echo "Exporting genes from gnomAD..."
        hail-decoder export parquet \
            --intervals-file "$INTERVALS_FILE" \
            "gs://gcp-public-data--gnomad/resources/grch38/browser/gnomad.genes.GRCh38.GENCODEv39.pext.ht" \
            data/genes.parquet
    else
        echo "genes.parquet already exists, skipping"
    fi
else
    echo "Skipping data export"
fi

# Build backend
if [[ "$SKIP_BUILD" != "true" ]]; then
    # sccache is the configured rustc wrapper (backend/.cargo/config.toml). If it
    # isn't installed, every cargo command fails cryptically — unset the wrapper so
    # the build works anyway (install sccache to get cross-worktree caching back).
    if ! command -v sccache &>/dev/null; then
        echo "sccache not found — building without it (set up sccache for faster rebuilds)"
        export CARGO_BUILD_RUSTC_WRAPPER=""
    fi

    # assistant-ui ships source-only; build it before the frontend install or that
    # install fails on the `file:` dependency.
    PARENT="$(cd "$PROJECT_ROOT/.." && pwd)"
    if [[ -d "$PARENT/genohype/ui" ]]; then
        echo ""
        echo "Building @genohype/assistant-ui..."
        (cd "$PARENT/genohype/ui" && npm install && npm run build -w @genohype/assistant-ui)
    fi

    echo ""
    echo "Checking DuckDB library..."
    preflight_duckdb

    echo ""
    echo "Building backend..."
    # The binary links DuckDB (a legacy backend) at build time via the system
    # library. If you have no system DuckDB, build with --features bundled instead.
    (cd backend && cargo build --release)

    echo ""
    echo "Installing dependencies..."
    pnpm install
    (cd frontend && pnpm install)
else
    echo "Skipping builds"
fi

# Generate port configuration
echo ""
echo "Generating port configuration..."

if [[ -n "$WORKTREE_NAME" ]]; then
    # Unique ports based on worktree name hash
    if command -v md5sum &>/dev/null; then
        HASH=$(echo -n "$WORKTREE_NAME" | md5sum | cut -c1-4)
    else
        HASH=$(echo -n "$WORKTREE_NAME" | md5 | cut -c1-4)
    fi
    HASH_NUM=$((16#$HASH % 1000))
    BACKEND_PORT=$((3000 + HASH_NUM))
    FRONTEND_PORT=$((5173 + HASH_NUM))
    ENV_COMMENT="# Worktree: $WORKTREE_NAME"
else
    # Default ports for main project
    BACKEND_PORT=3000
    FRONTEND_PORT=5173
    ENV_COMMENT="# Default configuration"
fi

cat > .env << EOF
$ENV_COMMENT
PORT=$BACKEND_PORT
DATA_DIR=../data
VITE_PORT=$FRONTEND_PORT
VITE_API_URL=http://localhost:$BACKEND_PORT
EOF

echo ""
echo "Setup complete!"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo "  Data:     $PROJECT_ROOT/data/"
echo ""
echo "To start the servers:"
echo "  ./scripts/start-backend.sh"
echo "  ./scripts/start-frontend.sh"
