-- DDL for genes table in ClickHouse
-- Contains gnomAD gene model data flattened for fast lookup.
--
-- Source: gnomAD genes Hail table exported via `genohype export clickhouse`
-- Matches ChGeneRow struct in backend/src/models/clickhouse.rs

CREATE TABLE IF NOT EXISTS genes (
    gene_id                   String,
    gencode_symbol            Nullable(String),
    chrom                     LowCardinality(String),
    start                     Int64,
    stop                      Int64,
    strand                    Nullable(String),
    canonical_transcript_id   Nullable(String),
    -- Transcripts serialized as JSON (nested-of-nested too complex for Nested type)
    transcripts_json          String DEFAULT '',

    INDEX idx_symbol (gencode_symbol) TYPE bloom_filter GRANULARITY 1
)
ENGINE = MergeTree()
ORDER BY (gene_id)
SETTINGS index_granularity = 8192
