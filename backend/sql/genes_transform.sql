-- Transform SQL for genes
-- Transforms staging_genes_raw -> genes
--
-- Extracts key fields and serializes transcripts to JSON.
-- The staging table is created by `genohype export clickhouse` with the
-- raw nested Hail schema.

INSERT INTO genes
SELECT
    gene_id,
    gencode_symbol,
    chrom,
    start,
    stop,
    strand,
    canonical_transcript_id,
    toJSONString(transcripts) AS transcripts_json
FROM staging_genes_raw
