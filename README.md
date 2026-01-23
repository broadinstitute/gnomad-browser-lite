# gnomAD Browser Lite

A lightweight, standalone variant browser powered by DuckDB and Parquet files. This project provides a simplified version of the gnomAD browser that can run locally without requiring a live ElasticSearch cluster or GraphQL API.

## Architecture

- **Backend**: Rust + Axum web server with DuckDB for querying Parquet files
- **Frontend**: React + TypeScript + Vite with styled-components

## Prerequisites

- Rust 1.70+
- Node.js 20.19+ (or 22.12+)
- `hail-decoder` CLI (for exporting data to Parquet)

## Data Setup

Before running the browser, you need to export the variant and gene data to Parquet format.

### 1. Define Test Intervals

The test intervals are pre-configured in `data/test_intervals.json`:
```json
[
  {"contig": "chr1", "start": 55039000, "end": 55065000},
  {"contig": "chr17", "start": 43044000, "end": 43126000}
]
```

These intervals cover PCSK9 and BRCA1 genes.

### 2. Export Variants to Parquet

```bash
hail-decoder export parquet \
  --input "gs://gcp-public-data--gnomad/release/4.1/ht/browser/gnomad.browser.v4.1.sites.ht" \
  --output data/variants.parquet \
  --intervals-file data/test_intervals.json
```

### 3. Export Gene Models to Parquet

```bash
hail-decoder export parquet \
  --input "gs://gcp-public-data--gnomad/resources/grch38/browser/gnomad.genes.GRCh38.GENCODEv39.pext.ht" \
  --output data/genes.parquet \
  --intervals-file data/test_intervals.json
```

## Running the Application

### Backend

```bash
cd backend
cargo run
```

The API server will start on `http://localhost:3000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend will start on `http://localhost:5173`.

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
npm run dev      # Development server
npm run build    # Production build
npm run preview  # Preview production build
```
