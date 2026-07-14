# LOFTEE Flags and Interpretation

LOFTEE (Loss-Of-Function Transcript Effect Estimator) is a VEP plugin that evaluates whether predicted loss-of-function variants are likely to result in actual loss of gene function.

## LOFTEE Confidence Levels

| LOF Field | Meaning | Action |
|-----------|---------|--------|
| `"HC"` | **High Confidence** — variant is likely a true LoF | Treat as genuine loss-of-function |
| `"LC"` | **Low Confidence** — variant may not impact gene function | Warn: may not actually cause LoF. Downweight pathogenicity evidence. |

## LOFFilter Field

The `LOFFilter` field provides the specific reason a variant was flagged or filtered by LOFTEE.

| LOFFilter Value | Meaning |
|-----------------|---------|
| `"PASS"` | No LOFTEE flags — high confidence pLoF |
| `"END_TRUNC"` | Variant falls in the last 5% of the transcript |
| `"INCOMPLETE_CDS"` | Transcript has an incomplete CDS annotation |
| `"EXON_INTRON_UNDEF"` | Exon/intron boundaries are undefined |
| `"SMALL_INTRON"` | Variant is in a very small intron (< 15 bp) |
| `"ANC_ALLELE"` | The LoF allele is the ancestral allele |
| `"NON_DONOR_DISRUPTING"` | Splice donor variant does not disrupt the donor motif |
| `"NON_ACCEPTOR_DISRUPTING"` | Splice acceptor variant does not disrupt the acceptor motif |
| `"RESCUE_DONOR"` | A nearby variant rescues the splice donor site |
| `"RESCUE_ACCEPTOR"` | A nearby variant rescues the splice acceptor site |
| `"GC_TO_GT_DONOR"` | GC>GT change at a splice donor (these often maintain splicing) |
| `"5UTR_SPLICE"` | Splice variant in the 5' UTR |
| `"3UTR_SPLICE"` | Splice variant in the 3' UTR |

## Interpretation Logic

```
if LOF == "LC":
    warn("Low confidence pLoF — may not impact gene function")
elif LOFFilter != "PASS":
    warn("LOFTEE filtered: {LOFFilter} — likely does not impact gene function")
else:
    # High confidence, passing pLoF
    # Strong evidence for loss of function
```

## High-Impact Consequences Evaluated by LOFTEE

LOFTEE is only relevant for predicted loss-of-function consequences:
- `frameshift_variant`
- `stop_gained` (nonsense)
- `splice_acceptor_variant`
- `splice_donor_variant`

For missense, synonymous, or other consequences, LOFTEE fields are not applicable.

## Sources

- Karczewski et al. 2020, *Nature* 581:434-443 (gnomAD v2 flagship, LOFTEE definition)
- LOFTEE GitHub: github.com/konradjk/loftee
- Implementation: `gmd-api/agent/tools/interpretation.go` lines 200-207
