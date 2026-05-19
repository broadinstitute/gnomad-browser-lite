-- Transform SQL for variants
-- Transforms staging_variants_raw -> variants
--
-- Flattens gnomAD's deeply nested schema:
-- - Extracts canonical transcript consequence from transcript_consequences array
-- - Extracts allele counts from exome.freq (with genome fallback)
-- - Serializes complex nested structures (exome, genome, joint, coverage,
--   in_silico_predictors) as JSON for pass-through to the frontend
--
-- Note: No trailing semicolon so a WHERE clause can be appended for --filter.

INSERT INTO variants
SELECT
    locus.contig AS chrom,
    locus.position AS pos,

    -- Variant ID (chr-pos-ref-alt)
    variant_id,

    -- Alleles array
    alleles,

    -- rsIDs
    COALESCE(rsids, []) AS rsids,

    -- CAID
    caid,

    -- Allele counts: prefer exome, fallback to genome
    COALESCE(
        exome.freq[indexOf(exome.freq.id, 'all')].ac,
        genome.freq[indexOf(genome.freq.id, 'all')].ac,
        0
    ) AS ac,
    COALESCE(
        exome.freq[indexOf(exome.freq.id, 'all')].an,
        genome.freq[indexOf(genome.freq.id, 'all')].an,
        0
    ) AS an,
    if(
        COALESCE(exome.freq[indexOf(exome.freq.id, 'all')].an, genome.freq[indexOf(genome.freq.id, 'all')].an, 0) > 0,
        COALESCE(exome.freq[indexOf(exome.freq.id, 'all')].ac, genome.freq[indexOf(genome.freq.id, 'all')].ac, 0)
            / COALESCE(exome.freq[indexOf(exome.freq.id, 'all')].an, genome.freq[indexOf(genome.freq.id, 'all')].an, 1),
        0.0
    ) AS af,

    -- Canonical transcript consequence (first element or filtered by is_canonical)
    transcript_consequences[1].major_consequence AS consequence,
    transcript_consequences[1].hgvsc AS hgvsc,
    transcript_consequences[1].hgvsp AS hgvsp,
    transcript_consequences[1].gene_id AS gene_id,
    transcript_consequences[1].gene_symbol AS gene_symbol,
    transcript_consequences[1].transcript_id AS transcript_id,
    transcript_consequences[1].lof AS lof,

    -- Full nested data serialized as JSON for detail view
    toJSONString(exome) AS exome_json,
    toJSONString(genome) AS genome_json,
    toJSONString(joint) AS joint_json,
    toJSONString(transcript_consequences) AS transcript_consequences_json,
    toJSONString(in_silico_predictors) AS in_silico_predictors_json,
    toJSONString(coverage) AS coverage_json

FROM staging_variants_raw
