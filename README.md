# gnomAD Browser Lite

A lightweight, self-hostable, **rebrandable** variant browser. It serves a
gnomAD-style gene / region / variant UI on top of a pluggable backend — from the
public gnomAD Hail tables on GCS (zero setup) to local Parquet, ClickHouse,
Postgres, or Elasticsearch. A single Rust binary (`gbl`) reads one `gbl.toml`
file that selects the backend and the branding, so multiple consortia can run
their own instance from the same code.

## Architecture

- **Backend** — Rust + Axum. One binary, `gbl`, with subcommands (`serve`,
  `load`, `validate`, `mcp`, …). The active data store is chosen at runtime by
  the `[backend]` section of `gbl.toml`.
- **Frontend** — React + TypeScript + Vite (styled-components). Reads branding
  from the backend's `/api/config`, so the same build re-skins per instance.
- **AI assistant** *(optional)* — a CopilotKit ↔ MCP bridge (`start-bridge.sh`)
  that exposes the backend's MCP server to an in-app assistant.

## Backends

Selected via `[backend] type = "..."` in `gbl.toml`:

| `type`          | Data store                                  | Notes |
|-----------------|---------------------------------------------|-------|
| `hail`          | gnomAD Hail tables on GCS                   | **Default.** Zero data prep; queries public `gs://gcp-public-data--gnomad/...` tables directly. |
| `duckdb`        | Local Parquet files                         | Fully offline. Requires exported `data/*.parquet` carrying a materialized `xpos` column. |
| `clickhouse`    | ClickHouse                                  | HTTP URL + database. |
| `postgres`      | Postgres (JSONB wide table)                 | `query_mode = "jsonb"` or `"typed"`. |
| `elasticsearch` | Elasticsearch                               | The gnomAD-prod-style baseline. |
| `tiered`        | Region-aware router over two backends       | Hot set (CDS/gene bodies) → `fast`, everything else → `fallback`. |
| `gcscache`      | Materialized response cache over a fallback | Gene-view responses served from RAM/SSD/lazy cache. |

The Postgres / ClickHouse / Elasticsearch / tiered / cache arms exist primarily
as benchmark backends; `hail` and `duckdb` are the two you'll use for local dev.

## Prerequisites

- Rust (stable) — `cargo`, and optionally [`cargo-watch`](https://crates.io/crates/cargo-watch) for backend hot reload
- sccache — caches Rust build artifacts so rebuilds are fast (`cargo install sccache`)
- A DuckDB library — the binary links it at build time (`brew install duckdb`, or build with `--features bundled` to compile it from source; see [Development](#development))
- Node.js 20.19+ (or 22.12+) and `pnpm`
- **Sibling repos:** the backend and frontend depend on the `genohype` and `fastVEP` repos **by path** — see [Repository layout](#repository-layout) before your first build.
- **For the default `hail` backend:** the [gcloud CLI](https://cloud.google.com/sdk/docs/install) with Application Default Credentials —
  ```bash
  gcloud auth application-default login
  ```
  The gnomAD buckets are public, but the GCS client still mints an OAuth token, so ADC must be present.
- **To export `duckdb` data:** the [`hail-decoder`](https://github.com/broadinstitute/hail-rust-decoder) CLI.

## Repository layout

`gnomad-browser-lite` is not standalone — it references two sibling repos **by path**
(`backend/Cargo.toml` → `../../genohype/*`; `frontend/package.json` →
`file:../../genohype/ui/...`; optional VEP deps → `../../fastVEP/crates/*`, which Cargo
resolves even with the `vep` feature off). Clone all three **side by side**:

```bash
mkdir genohype-eco && cd genohype-eco
git clone ssh://git@github.com/broadinstitute/gnomad-browser-lite.git
git clone ssh://git@github.com/broadinstitute/genohype.git             # branch: main
git clone ssh://git@github.com/mattsolo1/fastVEP.git                   # NOT upstream Huang-lab
(cd fastVEP && git checkout genohype-integration)                     # has the fastvep-loftee crate
```

```
genohype-eco/
  gnomad-browser-lite/   ← build here
  genohype/              (main)                 — core/pool/mcp crates + ui/
  fastVEP/               (genohype-integration) — fastvep-{core,io,annotate,loftee}
```

`@genohype/assistant-ui` ships source-only, so build it once before the frontend install:

```bash
(cd genohype/ui && npm install && npm run build -w @genohype/assistant-ui)
```

`./scripts/setup.sh` runs a preflight that checks for these siblings (and builds
assistant-ui) and stops with the exact commands if anything is missing.

## Quick start (zero-config, public gnomAD data)

No data export needed — this queries the public gnomAD tables on GCS directly.

```bash
gcloud auth application-default login   # once, if you haven't
pnpm install
pnpm start
```

`pnpm start` launches three processes together (via `concurrently`): the
**backend**, the AI-assistant **bridge**, and the **frontend**.

- Frontend → the `VITE_PORT` in `.env` (e.g. http://localhost:5173)
- Backend  → http://localhost:3000

> **First boot takes ~30 s to ~2 min.** The `hail` backend binds its port only
> *after* it builds an in-memory gene-symbol index (~60k symbols) and, if a
> `constraint_path` is configured, loads the constraint metrics table. Until
> then the UI shows **"API not available."** — that's expected; wait for this
> backend log line and refresh:
>
> ```
> INFO backend: Starting server on 0.0.0.0:3000
> ```

Open the frontend URL and search a gene (e.g. `PCSK9`).

### Selecting a config / branded instance

The zero-config default is the Hail backend on the public gnomAD tables with no
constraint panel and default branding. To run a specific configuration (backend,
constraint, branding), point `GBL_CONFIG` at a `gbl.toml`:

```bash
GBL_CONFIG=examples/gnomad/gbl.toml pnpm start
```

Both `start-backend.sh` and `start-bridge.sh` honor `GBL_CONFIG`. You can also
run the binary directly:

```bash
./backend/target/release/backend --config examples/gnomad/gbl.toml serve
```

## Configuration (`gbl.toml`)

Each instance is described by one TOML file. See [`examples/`](examples/) for
working configs (`gnomad`, `cgdc`, `singapore`, `vep-test`).

```toml
[server]
port = 3000
vite_port = 5900

[backend]
type = "hail"
variants_path    = "gs://gcp-public-data--gnomad/release/4.1.1/ht/browser/gnomad.browser.v4.1.1.sites.ht"
genes_path       = "gs://gcp-public-data--gnomad/resources/grch38/browser/gnomad.genes.GRCh38.GENCODEv39.pext.ht"
constraint_path  = "gs://gcp-public-data--gnomad/release/4.1.1/constraint/gnomad.v4.1.1.constraint_metrics.ht"
# Optional on-the-fly VEP annotation:
# vep_gff3  = "/path/to/Homo_sapiens.GRCh38.115.gff3.gz"
# vep_fasta = "/path/to/Homo_sapiens.GRCh38.dna.primary_assembly.fa"

[branding]
name             = "gnomAD Browser Lite"
navbar_color     = "#333"
accent_color     = "#0066cc"
# short_name, full_title, navbar_text_color, logo_url, favicon_url,
# homepage_content / about_content / terms_content (Markdown paths),
# external_links = [{ label = "...", url = "..." }]
```

To stand up a new consortium instance, copy an example, swap the `[backend]`
paths and `[branding]` fields, and run with `GBL_CONFIG` pointing at it.

## Running

```bash
pnpm start            # backend + bridge + frontend (concurrently)
pnpm stop             # kill servers using ports from .env

pnpm start:backend    # backend only  (./scripts/start-backend.sh)
pnpm start:bridge     # AI bridge only (./scripts/start-bridge.sh)
pnpm start:frontend   # frontend only  (./scripts/start-frontend.sh)
```

### Ports & worktrees

Ports live in `.env` (gitignored, generated by setup). **Always check `.env`
before starting or killing servers** — each worktree gets its own deterministic
ports so multiple instances run at once.

```bash
cat .env   # PORT (backend), VITE_PORT (frontend), VITE_API_URL
```

```bash
# Create an isolated worktree with its own data + ports
./scripts/setup.sh --create-worktree ../my-feature
./scripts/setup.sh --create-worktree ../my-feature --from-main   # fast: copy data/build from main

# Configure an existing worktree
./scripts/setup.sh --worktree-name my-feature
```

## The `gbl` CLI

The backend binary is a multi-command CLI (`--config <path>` is global):

| Command | Purpose |
|---------|---------|
| `serve [--port N]` | Start the REST API server (default command). |
| `load <src> --target duck-db\|click-house --table-type genes\|variants` | ETL a Hail table into a backend. |
| `validate <src> [--schema f.json]` | Validate a source table against the expected gnomAD schema. |
| `mcp stdio` | Run the MCP server over stdio (used by the CopilotKit bridge / Claude Desktop). |
| `pool …` / `clickhouse …` | Manage GCP worker pools / ClickHouse infra (advanced). |

Run `./backend/target/release/backend --help` (or `cargo run -- --help`) for the full list.

## Offline / local DuckDB path

To run without any network access, export the gnomAD tables to Parquet and use
the `duckdb` backend:

```bash
./scripts/setup.sh                 # exports data/{variants,genes}.parquet, builds, writes .env
GBL_CONFIG=examples/local/gbl.toml pnpm start   # a duckdb config pointing at data/
```

The exported Parquet **must include a materialized `xpos` column** (global
coordinate = `contig_number * 1e9 + position`); the DuckDB backend range-prunes
region/point queries on it. Parquet exported before that column was introduced
will fail variant queries with *"Failed to prepare variants query"* — re-export
with a current `hail-decoder` / `gbl load`.

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check |
| `GET /api/config` | Branding / instance config (consumed by the frontend) |
| `GET /api/search?q=:query` | Search genes by symbol prefix |
| `GET /api/gene/:gene_id` | Gene by Ensembl ID or symbol (incl. constraint) |
| `GET /api/gene/:gene_id/variants` | Variants for a gene |
| `GET /api/gene/:gene_id/variants/stream` | Streaming variant rows for a gene |
| `GET /api/region/:region_id` | Variants in a region (`1-55039447-55064852`) |
| `GET /api/variants/stream` | Streaming variants for a region |
| `GET /api/variant/:variant_id` | Single variant detail (`1-55039447-C-T`) |
| `GET /api/schema/:table` | Table schema (`genes` or `variants`) |

## Project structure

```
gnomad-browser-lite/
├── scripts/                # setup.sh, start-{backend,bridge,frontend}.sh, stop.sh
├── examples/               # per-instance gbl.toml configs (gnomad, cgdc, singapore, vep-test)
├── data/                   # exported Parquet + test_intervals.json (gitignored parquet)
├── backend/                # Rust `gbl` binary
│   └── src/
│       ├── main.rs         # Axum routes + server bootstrap
│       ├── config.rs       # gbl.toml parsing + backend selection
│       ├── cli.rs          # clap CLI definition
│       └── backend/        # hail, duckdb, clickhouse, postgres, elasticsearch, tiered, gcs_cache, xpos
└── frontend/               # React app (pages: Home, Gene, Region, Variant)
```

## Development

sccache is the committed rustc wrapper (`backend/.cargo/config.toml`); install it (see
Prerequisites), or build without it by prefixing cargo commands with
`CARGO_BUILD_RUSTC_WRAPPER=""`. The binary links DuckDB at build time via the system
library; if you have no system DuckDB, add `--features bundled` to compile it from source.

```bash
# Backend
cd backend
cargo check
cargo run -- --config ../examples/gnomad/gbl.toml serve

# Frontend
cd frontend
pnpm dev        # dev server (Vite HMR)
pnpm build      # production build
pnpm preview    # preview production build
```

Frontend changes hot-reload via Vite. With `cargo-watch` installed, the backend
rebuilds on change (note: a rebuild re-triggers the Hail startup scan).
