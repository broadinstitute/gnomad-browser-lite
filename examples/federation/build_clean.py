#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Build the *clean* federation QC fixture from real gnomAD v4.1 genomes sites.

This is the reproducibility script for ``partner-clean.vcf.bgz``. It carves a
small, multi-region slice out of the public gnomAD v4.1 genomes sites Hail
Table and re-emits it as a **sites-only** VCF whose INFO column mirrors the
gnomAD VCF frequency layout (global + per-genetic-ancestry + per-sex +
ancestry x sex ``AC``/``AN``/``AF``/``nhomalt``).

Why we don't use ``genohype export vcf``: that path only projects the flat
``info`` struct and drops the top-level positional ``freq`` array together with
the ``freq_meta`` globals that index it (see genohype inbox note
20260714-vcf-freq-array-drop). So we read ``freq`` + ``freq_meta`` ourselves via
``genohype query --json`` / ``genohype info --globals`` and flatten them here.

All aggregate strata (global, per-ancestry, per-sex) are **derived by summing
the finest ancestry x sex cells**, so the fixture is arithmetically
self-consistent by construction: ``AC <= AN``, ``AF == AC/AN``, subgroup sums
equal the global, and ``nhomalt <= AC/2`` all hold. That is what makes the
Tier-1 QC checks PASS on this file. ``make_broken.py`` then injects documented
defects to produce the failing counterpart.

Usage (stdlib only; run with uv, which pins the interpreter):
    uv run build_clean.py                # writes partner-clean.vcf(.bgz + .tbi)
    uv run build_clean.py --no-compress  # leave the plain .vcf in place
"""

import argparse
import json
import os
import subprocess
import sys

HT = "gs://gcp-public-data--gnomad/release/4.1/ht/genomes/gnomad.genomes.v4.1.sites.ht"

# gnomAD v4 genetic-ancestry groups we carry (matches the fixture spec).
GROUPS = ["afr", "amr", "asj", "eas", "fin", "nfe", "sas", "remaining"]
SEXES = ["XX", "XY"]

# Region set. Ordered by contig so the emitted VCF is coordinate-sorted for
# tabix (each contig appears in exactly one, position-sorted region).
# (contig, start, end, label)
REGIONS = [
    ("chr1", 55039000, 55065000, "PCSK9"),
    ("chr17", 43044000, 43126000, "BRCA1"),
    ("chr21", 20000000, 20150000, "chr21 window"),
    ("chr22", 20000000, 20150000, "chr22 window"),
    ("chrX", 23000000, 23100000, "chrX window (non-PAR)"),
    ("chrY", 2800000, 3300000, "chrY window (non-PAR, male-specific)"),
]

# GRCh38 primary-assembly contig lengths for the ##contig header lines.
CONTIG_LEN = {
    "chr1": 248956422,
    "chr17": 83257441,
    "chr21": 46709983,
    "chr22": 50818468,
    "chrX": 156040895,
    "chrY": 57227415,
}

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_VCF = os.path.join(HERE, "partner-clean.vcf")


def load_freq_index():
    """Return {'global': i, (group, sex): i} indices into the freq array."""
    out = subprocess.run(
        ["genohype", "info", HT, "--globals"],
        capture_output=True, text=True, check=True,
    ).stdout
    globals_ = json.loads(out)
    fm = globals_["freq_meta"]

    def parse(meta):
        return {e["key"]: e["value"] for e in meta}

    idx = {}
    for i, meta in enumerate(fm):
        p = parse(meta)
        if p == {"group": "adj"}:
            idx["global"] = i
        elif p.keys() == {"gen_anc", "group", "sex"} and p["group"] == "adj":
            if p["gen_anc"] in GROUPS and p["sex"] in SEXES:
                idx[(p["gen_anc"], p["sex"])] = i

    missing = [("global",)] if "global" not in idx else []
    missing += [(g, s) for g in GROUPS for s in SEXES if (g, s) not in idx]
    if missing:
        sys.exit(f"freq_meta missing expected strata: {missing}")
    return idx


def fmt_af(ac, an):
    """AF = AC/AN, or '.' (missing) when AN == 0 — mirrors gnomAD."""
    if an <= 0:
        return "."
    return f"{ac / an:.6g}"


def cell(freq, i):
    """(AC, AN, nhomalt) for freq array entry i; zeros if absent/null."""
    if i is None or i >= len(freq) or freq[i] is None:
        return 0, 0, 0
    e = freq[i]
    return (
        int(e.get("AC") or 0),
        int(e.get("AN") or 0),
        int(e.get("homozygote_count") or 0),
    )


def info_string(freq, idx):
    """Flatten the freq array for one variant into gnomAD-style INFO keys.

    Every aggregate is summed from the ancestry x sex cells so the record is
    internally consistent regardless of what the source globals total to.
    """
    # Finest cells: (group, sex) -> (ac, an, nh)
    cells = {(g, s): cell(freq, idx[(g, s)]) for g in GROUPS for s in SEXES}

    parts = []

    def emit(suffix, ac, an, nh):
        tag = f"_{suffix}" if suffix else ""
        parts.append(f"AC{tag}={ac}")
        parts.append(f"AN{tag}={an}")
        parts.append(f"AF{tag}={fmt_af(ac, an)}")
        parts.append(f"nhomalt{tag}={nh}")

    # Global = sum over all cells.
    g_ac = sum(c[0] for c in cells.values())
    g_an = sum(c[1] for c in cells.values())
    g_nh = sum(c[2] for c in cells.values())
    emit("", g_ac, g_an, g_nh)

    # Per sex = sum over ancestry groups.
    for s in SEXES:
        ac = sum(cells[(g, s)][0] for g in GROUPS)
        an = sum(cells[(g, s)][1] for g in GROUPS)
        nh = sum(cells[(g, s)][2] for g in GROUPS)
        emit(s, ac, an, nh)

    # Per ancestry group = sum over sexes.
    for g in GROUPS:
        ac = sum(cells[(g, s)][0] for s in SEXES)
        an = sum(cells[(g, s)][1] for s in SEXES)
        nh = sum(cells[(g, s)][2] for s in SEXES)
        emit(g, ac, an, nh)

    # Ancestry x sex (finest).
    for g in GROUPS:
        for s in SEXES:
            ac, an, nh = cells[(g, s)]
            emit(f"{g}_{s}", ac, an, nh)

    return ";".join(parts)


def header():
    lines = [
        "##fileformat=VCFv4.3",
        "##reference=GRCh38",
        '##source=gnomad-browser-lite federation QC fixture (build_clean.py)',
        f'##source_table={HT}',
    ]
    for contig, _, _, _ in REGIONS:
        lines.append(f"##contig=<ID={contig},length={CONTIG_LEN[contig]}>")
    # FILTER values carried over from gnomAD.
    for fid, desc in [
        ("PASS", "All filters passed"),
        ("AC0", "Allele count is zero after filtering"),
        ("AS_VQSR", "Failed allele-specific VQSR"),
        ("InbreedingCoeff", "Inbreeding coefficient filter"),
    ]:
        lines.append(f'##FILTER=<ID={fid},Description="{desc}">')

    def info(iid, num, typ, desc):
        lines.append(f'##INFO=<ID={iid},Number={num},Type={typ},Description="{desc}">')

    def strata_info(suffix, label):
        tag = f"_{suffix}" if suffix else ""
        info(f"AC{tag}", "A", "Integer", f"Alternate allele count for {label}")
        info(f"AN{tag}", "1", "Integer", f"Total allele number for {label}")
        info(f"AF{tag}", "A", "Float", f"Alternate allele frequency for {label}")
        info(f"nhomalt{tag}", "A", "Integer", f"Homozygous alt genotype count for {label}")

    strata_info("", "the whole callset (adj)")
    for s in SEXES:
        strata_info(s, f"sex karyotype {s}")
    for g in GROUPS:
        strata_info(g, f"genetic-ancestry group {g}")
    for g in GROUPS:
        for s in SEXES:
            strata_info(f"{g}_{s}", f"{g} / {s}")

    lines.append("#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO")
    return "\n".join(lines) + "\n"


def clean_filters(filters):
    if not filters:
        return "PASS"
    vals = [f for f in filters if f]
    return ";".join(vals) if vals else "PASS"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-compress", action="store_true",
                    help="leave the plain .vcf; skip bgzip + tabix")
    args = ap.parse_args()

    idx = load_freq_index()
    print(f"freq index resolved: global + {len(GROUPS)}x{len(SEXES)} cells", file=sys.stderr)

    n = 0
    with open(OUT_VCF, "w") as out:
        out.write(header())
        for contig, start, end, label in REGIONS:
            interval = f"{contig}:{start}-{end}"
            print(f"querying {interval} ({label}) ...", file=sys.stderr)
            proc = subprocess.Popen(
                ["genohype", "query", HT, "--interval", interval,
                 "--fields", "locus,alleles,freq,filters", "--json"],
                stdout=subprocess.PIPE, text=True,
            )
            # genohype's --interval scan parallelizes across partitions and does
            # NOT guarantee position-sorted output when a window straddles a
            # partition boundary, so buffer this region's records and sort by
            # position before writing (each region is a single contig, so the
            # emitted VCF ends up globally coordinate-sorted for tabix).
            region_rows = []
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                locus = row["locus"]
                alleles = row["alleles"]
                if len(alleles) != 2:
                    continue  # sites HT is biallelic-split; guard anyway
                ref, alt = alleles[0], alleles[1]
                info = info_string(row.get("freq") or [], idx)
                flt = clean_filters(row.get("filters"))
                pos = locus["position"]
                region_rows.append(
                    (pos, f"{locus['contig']}\t{pos}\t.\t{ref}\t{alt}\t.\t{flt}\t{info}\n")
                )
            proc.wait()
            if proc.returncode != 0:
                sys.exit(f"genohype query failed for {interval}")
            region_rows.sort(key=lambda r: r[0])
            for _, rec in region_rows:
                out.write(rec)
            n += len(region_rows)
            print(f"  {len(region_rows)} records", file=sys.stderr)

    print(f"wrote {n} records to {OUT_VCF}", file=sys.stderr)

    if not args.no_compress:
        bgz = OUT_VCF + ".bgz"
        with open(bgz, "wb") as fh:
            subprocess.run(["bgzip", "-c", OUT_VCF], stdout=fh, check=True)
        os.remove(OUT_VCF)
        subprocess.run(["tabix", "-p", "vcf", bgz], check=True)
        print(f"compressed -> {bgz} (+ .tbi)", file=sys.stderr)


if __name__ == "__main__":
    main()
