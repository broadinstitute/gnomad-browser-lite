# gnomAD Browser Lite

A lightweight, standalone variant browser that uses DuckDB and Parquet files for storage. This project provides a simplified version of the gnomAD browser that can run locally without requiring a live ElasticSearch cluster or GraphQL API.

## Architecture

- **Backend**: Rust + Axum web server with DuckDB for querying Parquet files
- **Frontend**: React + TypeScript + Vite with styled-components

## Prerequisites

- Rust 1.70+
- Node.js 20.19+ (or 22.12+)
- pnpm
- [DuckDB](https://duckdb.org/) (system library, e.g., `brew install duckdb`)
- [`hail-decoder`](https://github.com/broadinstitute/hail-rust-decoder) CLI (for exporting data to Parquet)
- Optional: `cargo-watch` for backend hot reload (`cargo install cargo-watch`)

## Quick Start

```bash
./scripts/setup.sh
```

This will:
1. Export variant and gene data from gnomAD to Parquet files
2. Build the backend
3. Install frontend dependencies
4. Generate port configuration

Then start the servers:

```bash
./scripts/start-backend.sh   # Terminal 1
./scripts/start-frontend.sh  # Terminal 2
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

## Working with Worktrees

For parallel development on multiple branches, create isolated worktrees with unique ports:

```bash
# Create a worktree with its own data and ports
./scripts/setup.sh --create-worktree ../my-feature

# Or setup an existing worktree
./scripts/setup.sh --worktree-name my-feature
```

Each worktree gets deterministic ports based on its name, so multiple instances can run simultaneously without conflicts.

### Setup Options

```bash
./scripts/setup.sh [OPTIONS]

Options:
    --worktree-name NAME    Name for unique port generation
    --create-worktree PATH  Create a new git worktree at PATH
    --branch BRANCH         Branch for new worktree (default: new branch from HEAD)
    --intervals FILE        Intervals file for data export (default: data/test_intervals.json)
    --skip-data             Skip parquet data export
    --skip-build            Skip backend/frontend builds
```

## Data Configuration

The test intervals are configured in `data/test_intervals.json`:
```json
[
  {"contig": "chr1", "start": 55039000, "end": 55065000},
  {"contig": "chr17", "start": 43044000, "end": 43126000}
]
```

These intervals cover PCSK9 and BRCA1 genes. Edit this file and re-run setup to include different regions.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `GET /api/gene/:gene_id` | Get gene by ID or symbol |
| `GET /api/gene/:gene_id/variants` | Get variants for a gene |
| `GET /api/region/:region_id` | Get variants in a region (format: `chr1-55039000-55065000`) |
| `GET /api/search?q=:query` | Search genes by symbol prefix |
| `GET /api/schema/:table` | Get table schema (genes or variants) |

## Project Structure

```
gnomad-browser-lite/
├── scripts/                   # Setup and run scripts
│   ├── setup.sh              # Main setup script
│   ├── start-backend.sh      # Start backend server
│   └── start-frontend.sh     # Start frontend dev server
├── data/                      # Parquet files and intervals config
│   ├── test_intervals.json    # Genomic intervals to export
│   ├── variants.parquet       # Exported variant data (gitignored)
│   └── genes.parquet          # Exported gene data (gitignored)
├── backend/                   # Rust API server
│   ├── src/
│   │   ├── main.rs           # Axum routes and server
│   │   └── db.rs             # DuckDB database layer
│   └── Cargo.toml
└── frontend/                  # React application
    ├── src/
    │   ├── api/              # API client and types
    │   ├── components/       # Reusable components
    │   ├── pages/            # Page components
    │   └── App.tsx           # Main app with routing
    └── package.json
```

## Features

- **Gene View**: View gene information and associated variants
- **Region View**: Browse variants in a genomic region
- **Search**: Find genes by symbol prefix
- **Variant Table**: Sortable, filterable table with key annotations

## Development

### Backend

```bash
cd backend
cargo check   # Type check
cargo run     # Run server
```

### Frontend

```bash
cd frontend
pnpm dev      # Development server
pnpm build    # Production build
pnpm preview  # Preview production build
```
