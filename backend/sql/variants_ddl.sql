-- DDL for variants table in ClickHouse
-- Contains gnomAD variant data flattened for fast region/gene queries.
--
-- Source: gnomAD browser sites Hail table exported via `genohype export clickhouse`
-- Matches both ChVariantRow (list view) and ChVariantDetailRow (detail view)
-- in backend/src/models/clickhouse.rs
--
-- List-view columns (lightweight, for variant table):
--   chrom, pos, variant_id, alleles, rsids, ac, an, af,
--   consequence, hgvsc, hgvsp, gene_id, gene_symbol, transcript_id, lof
--
-- Detail-view columns (full nested data as JSON pass-through):
--   caid, exome_json, genome_json, joint_json,
--   transcript_consequences_json, in_silico_predictors_json, coverage_json

CREATE TABLE IF NOT EXISTS variants (
    -- Position key
    chrom                          LowCardinality(String),
    pos                            Int64,

    -- Variant identifiers
    variant_id                     Nullable(String),
    alleles                        Array(String),
    rsids                          Array(String),
    caid                           Nullable(String),

    -- Allele counts (from exome freq.all, with genome fallback)
    ac                             Int64 DEFAULT 0,
    an                             Int64 DEFAULT 0,
    af                             Float64 DEFAULT 0.0,

    -- Canonical transcript consequence (flattened from transcript_consequences array)
    consequence                    Nullable(String),
    hgvsc                          Nullable(String),
    hgvsp                          Nullable(String),
    gene_id                        Nullable(String),
    gene_symbol                    Nullable(String),
    transcript_id                  Nullable(String),
    lof                            Nullable(String),

    -- Full nested data as JSON strings (for detail view pass-through)
    exome_json                     String DEFAULT '',
    genome_json                    String DEFAULT '',
    joint_json                     String DEFAULT '',
    transcript_consequences_json   String DEFAULT '',
    in_silico_predictors_json      String DEFAULT '',
    coverage_json                  String DEFAULT '',

    INDEX idx_variant_id (variant_id) TYPE bloom_filter GRANULARITY 1
)
ENGINE = MergeTree()
ORDER BY (chrom, pos)
SETTINGS index_granularity = 8192
