# gnomad-bench shared API image — the Rust VariantBackend server (this crate).
#
# Built via Cloud Build from a STAGED, hermetic context that contains this crate
# plus the genohype workspace it `path`-depends on (core/cli/pool/mcp), so the
# path deps resolve with no git auth and no Cargo.toml changes. The staging is
# assembled by gnomad-bench/scripts/build-api-image.sh; the context layout is:
#
#   genohype/{Cargo.toml,Cargo.lock,core,cli,pool,mcp}   # workspace, no target/
#   gnomad-browser-lite/backend/                          # this crate, no target/
#
# Zero-config default backend = hail-gcs over public gnomAD GCS, so the image runs
# end-to-end with no config file (the lean-smoke first signal). Other arms are
# selected at runtime with `backend --config <arm>.toml`.

FROM rust:1.91-slim-bookworm AS builder

# Build deps: DuckDB `bundled` compiles the amalgamation (cc/cmake) and its
# bindings use clang/libclang; openssl-sys (pulled transitively) needs
# pkg-config + libssl. All builder-stage only — the runtime image stays slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake clang libclang-dev pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY genohype /src/genohype
COPY gnomad-browser-lite/backend /src/gnomad-browser-lite/backend

WORKDIR /src/gnomad-browser-lite/backend
# `bundled` = self-contained DuckDB (no system libduckdb needed at runtime).
RUN cargo build --release --features bundled

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /usr/sbin/nologin bench

COPY --from=builder /src/gnomad-browser-lite/backend/target/release/backend /usr/local/bin/backend

USER bench
ENV RUST_LOG=info
# The server resolves its listen port from $PORT (Cloud Run overrides this to
# match container_port; see infra/main.tf api_port).
ENV PORT=8000
EXPOSE 8000

# No subcommand = serve. Default config (no file) = hail-gcs over public GCS.
CMD ["backend"]
