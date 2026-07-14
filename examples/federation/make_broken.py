#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Deterministically mutate the clean fixture into the *broken* fixture.

Reads ``partner-clean.vcf.bgz`` and writes ``partner-broken.vcf.bgz`` (+ .tbi)
plus ``defects.json`` — a machine-readable manifest listing, per defect, the
exact variant ids affected and the QC check(s) each defect is designed to trip.
The manifest is the contract that the `gbl qc` check tests (plan 02) and the
`/qc` walking-skeleton demo (plan 72) assert against.

Every edit is deterministic (records are selected by file order + fixed
predicates, never at random) so clean -> broken is fully reproducible. Each
arithmetic/schema defect is applied to a small, disjoint set of records and is
crafted to trip **only** its target check — e.g. the AC>AN records are rewritten
into an otherwise self-consistent state (subgroup sums, AF, nhomalt all hold) so
that only `arith.ac-le-an` fires on them. See DEFECTS below and the README table.

Dependency-light: standard library only (gzip + subprocess for bgzip/tabix).

Usage (stdlib only; run with uv, which pins the interpreter):
    uv run make_broken.py                 # clean.vcf.bgz -> broken.vcf.bgz + defects.json
    uv run make_broken.py --no-compress   # write plain broken.vcf, skip bgzip/tabix
"""

import argparse
import gzip
import json
import os
import subprocess
import sys

GROUPS = ["afr", "amr", "asj", "eas", "fin", "nfe", "sas", "remaining"]
SEXES = ["XX", "XY"]
TRANSITIONS = {("A", "G"), ("G", "A"), ("C", "T"), ("T", "C")}
# Transition -> transversion substitution for defect 10 (deterministic).
TS_TO_TV_ALT = {"G": "C", "A": "C", "T": "G", "C": "A"}

# How many chr22 PASS transitions to flip to transversions (defect 10). Bounded
# and documented; sized to clearly depress the Ti/Tv ratio in the chr22 window.
N_TITV_FLIP = 4000
# "Common" AF threshold for the contamination / inbreeding-F defect (9).
COMMON_AF = 0.05
N_PER_ARITH_DEFECT = 5

HERE = os.path.dirname(os.path.abspath(__file__))
CLEAN = os.path.join(HERE, "partner-clean.vcf.bgz")
OUT_VCF = os.path.join(HERE, "partner-broken.vcf")
OUT_BGZ = OUT_VCF + ".bgz"
MANIFEST = os.path.join(HERE, "defects.json")

# Karyotypic-ish contig order used only to keep the output coordinate-grouped.
CONTIG_RANK = {"1": 0, "chr1": 1, "chr17": 2, "chr21": 3, "chr22": 4, "chrX": 5, "chrY": 6}


def fmt_af(ac, an):
    return "." if an <= 0 else f"{ac / an:.6g}"


def variant_id(contig, pos, ref, alt):
    """gnomAD-browser style id, e.g. '1-55039020-T-C' (leading 'chr' stripped)."""
    c = contig[3:] if contig.startswith("chr") else contig
    return f"{c}-{pos}-{ref}-{alt}"


class Record:
    __slots__ = ("contig", "pos", "id", "ref", "alt", "qual", "flt", "keys", "info", "drop")

    def __init__(self, line):
        f = line.rstrip("\n").split("\t")
        self.contig, pos, self.id, self.ref, self.alt, self.qual, self.flt = f[:7]
        self.pos = int(pos)
        self.keys = []            # preserve INFO key order
        self.info = {}
        for kv in f[7].split(";"):
            k, v = kv.split("=", 1)
            self.keys.append(k)
            self.info[k] = v
        self.drop = False

    def vid(self):
        return variant_id(self.contig, self.pos, self.ref, self.alt)

    def set_uniform(self, ac, an, nh):
        """Concentrate the whole frequency structure in afr / XX / afr_XX so the
        record stays internally consistent except for the injected relation."""
        def put(suffix, a, n, h):
            tag = f"_{suffix}" if suffix else ""
            self.info[f"AC{tag}"] = str(a)
            self.info[f"AN{tag}"] = str(n)
            self.info[f"AF{tag}"] = fmt_af(a, n)
            self.info[f"nhomalt{tag}"] = str(h)

        put("", ac, an, nh)
        put("XX", ac, an, nh)
        put("XY", 0, 0, 0)
        for g in GROUPS:
            put(g, ac, an, nh) if g == "afr" else put(g, 0, 0, 0)
        for g in GROUPS:
            for s in SEXES:
                if (g, s) == ("afr", "XX"):
                    put(f"{g}_{s}", ac, an, nh)
                else:
                    put(f"{g}_{s}", 0, 0, 0)

    def serialize(self):
        info = ";".join(f"{k}={self.info[k]}" for k in self.keys if k in self.info)
        return (f"{self.contig}\t{self.pos}\t{self.id}\t{self.ref}\t{self.alt}\t"
                f"{self.qual}\t{self.flt}\t{info}\n")


def rename_nfe_to_oth(rec):
    """Defect 1: relabel the (retired) nfe strata as 'oth' in every INFO key."""
    new_keys, new_info = [], {}
    for k in rec.keys:
        nk = k.replace("_nfe", "_oth")
        new_keys.append(nk)
        new_info[nk] = rec.info[k]
    rec.keys, rec.info = new_keys, new_info


def transform_header(lines, drop_chry):
    out = []
    for ln in lines:
        if ln.startswith("##contig"):
            if drop_chry and "ID=chrY" in ln:
                continue  # defect 8: chrY gone
            out.append(ln)
            if "ID=chr1," in ln:
                # defect 2: declare the non-GRCh38 contig '1' we introduce.
                out.append("##contig=<ID=1,length=249250621>\n")
        elif ln.startswith("##INFO") and "_nfe" in ln:
            out.append(ln.replace("_nfe", "_oth").replace(" nfe", " oth"))
        else:
            out.append(ln)
    return out


def claim(cursor_state, records, chr1_idx, pred, n):
    """Claim the next n unclaimed chr1 records matching pred; return their idxs."""
    claimed = cursor_state["claimed"]
    picked = []
    i = cursor_state["cursor"]
    while len(picked) < n and i < len(chr1_idx):
        idx = chr1_idx[i]
        i += 1
        if idx in claimed:
            continue
        if pred(records[idx]):
            claimed.add(idx)
            picked.append(idx)
    cursor_state["cursor"] = i
    if len(picked) < n:
        sys.exit(f"could not find {n} chr1 records matching predicate")
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-compress", action="store_true")
    args = ap.parse_args()

    header, records = [], []
    with gzip.open(CLEAN, "rt") as f:
        for ln in f:
            if ln.startswith("#"):
                header.append(ln)
            else:
                records.append(Record(ln))

    chr1_idx = [i for i, r in enumerate(records) if r.contig == "chr1"]
    st = {"cursor": 0, "claimed": set()}

    defects = []  # manifest entries

    MAX_EXAMPLES = 20

    def record_defect(num, name, checks, tier, idxs, note):
        # Store the full count but only a bounded sample of ids (matches the QC
        # report schema, which keeps a bounded sample of offending variants).
        defects.append({
            "defect": num, "name": name, "checks": checks, "tier": tier,
            "n_records": len(idxs),
            "example_variant_ids": [records[i].vid() for i in idxs[:MAX_EXAMPLES]],
            "note": note,
        })

    # --- Defect 2: non-GRCh38 contig (chr1 -> 1) on 5 records ---
    d2 = claim(st, records, chr1_idx, lambda r: True, N_PER_ARITH_DEFECT)
    for i in d2:
        records[i].contig = "1"
    record_defect(2, "Non-GRCh38 contig", ["fields.contigs-grch38"], 1, d2,
                  "CHROM relabeled chr1 -> 1 (GRCh37-style).")
    # capture ids AFTER relabel so they match the broken file (contig '1')
    defects[-1]["example_variant_ids"] = [records[i].vid() for i in d2[:MAX_EXAMPLES]]

    # --- Defect 3: missing required field (drop global nhomalt) on 5 records ---
    d3 = claim(st, records, chr1_idx, lambda r: True, N_PER_ARITH_DEFECT)
    for i in d3:
        r = records[i]
        r.keys = [k for k in r.keys if k != "nhomalt"]
        r.info.pop("nhomalt", None)
    record_defect(3, "Missing required field", ["fields.required"], 1, d3,
                  "Global nhomalt INFO key removed.")

    # --- Defect 4: AC > AN on 5 records (only arith.ac-le-an) ---
    d4 = claim(st, records, chr1_idx, lambda r: True, N_PER_ARITH_DEFECT)
    for i in d4:
        records[i].set_uniform(ac=51, an=40, nh=0)
    record_defect(4, "AC greater than AN", ["arith.ac-le-an"], 1, d4,
                  "Record rewritten to AC=51, AN=40 (AF, subgroup sums, nhomalt "
                  "left self-consistent so only ac-le-an trips).")

    # --- Defect 5: AF != AC/AN on 5 records (only arith.af-consistent) ---
    d5 = claim(st, records, chr1_idx, lambda r: True, N_PER_ARITH_DEFECT)
    for i in d5:
        records[i].info["AF"] = "0.5"  # real AC/AN here is ~1e-5
    record_defect(5, "AF inconsistent with AC/AN", ["arith.af-consistent"], 1, d5,
                  "Global AF overwritten to 0.5 while AC/AN unchanged.")

    # --- Defect 6: subgroup sum != global (only arith.subgroup-sums) ---
    d6 = claim(st, records, chr1_idx,
               lambda r: int(r.info.get("AN_afr", "0")) > 100, N_PER_ARITH_DEFECT)
    for i in d6:
        r = records[i]
        an_afr = int(r.info["AN_afr"])
        new_ac = int(r.info["AC_afr"]) + 25
        r.info["AC_afr"] = str(new_ac)
        r.info["AF_afr"] = fmt_af(new_ac, an_afr)  # keep afr internally consistent
    record_defect(6, "Subgroup sum != global", ["arith.subgroup-sums"], 1, d6,
                  "AC_afr bumped by 25 without touching global AC (AF_afr kept "
                  "consistent, AC_afr<=AN_afr, so only subgroup-sums trips).")

    # --- Defect 7: nhomalt > AC/2 on 5 records (only arith.nhomalt-le-half-ac) ---
    d7 = claim(st, records, chr1_idx,
               lambda r: int(r.info.get("AC", "0")) >= 2, N_PER_ARITH_DEFECT)
    for i in d7:
        r = records[i]
        r.info["nhomalt"] = r.info["AC"]  # nhomalt == AC > AC/2
    record_defect(7, "nhomalt > AC/2", ["arith.nhomalt-le-half-ac"], 1, d7,
                  "Global nhomalt set equal to AC (impossible; > AC/2).")

    arith_claimed = set(st["claimed"])

    # --- Defect 8: missing chrY (drop all chrY records) ---
    d8 = [i for i, r in enumerate(records) if r.contig == "chrY"]
    for i in d8:
        records[i].drop = True
    record_defect(8, "Missing chrY", ["complete.chromosomes", "bio.chrxy"], 1, d8,
                  f"All {len(d8)} chrY records dropped; chrY ##contig line removed.")

    # --- Defect 9: contamination signature (depress nhomalt on common sites) ---
    d9 = []
    for i, r in enumerate(records):
        if r.drop or i in arith_claimed or r.contig == "chrY":
            continue
        an = int(r.info.get("AN", "0"))
        ac = int(r.info.get("AC", "0"))
        if an > 0 and ac / an >= COMMON_AF:
            for k in list(r.info):
                if k.startswith("nhomalt"):
                    r.info[k] = "0"
            d9.append(i)
    record_defect(9, "Contamination signature (low nhomalt)", ["bio.inbreeding-f"], 2, d9,
                  f"nhomalt zeroed on all strata for {len(d9)} common (AF>="
                  f"{COMMON_AF}) sites -> excess heterozygosity, F << 0. "
                  "Approximate: Tier-2 band is calibrated later.")

    # --- Defect 10: poor filtering (transitions -> transversions, depress Ti/Tv) ---
    d10 = []
    for i, r in enumerate(records):
        if len(d10) >= N_TITV_FLIP:
            break
        if r.drop or r.contig != "chr22" or r.flt != "PASS":
            continue
        if len(r.ref) == 1 and len(r.alt) == 1 and (r.ref, r.alt) in TRANSITIONS:
            r.alt = TS_TO_TV_ALT[r.ref]  # now a transversion
            d10.append(i)
    record_defect(10, "Poor filtering (low Ti/Tv)", ["bio.titv"], 2, d10,
                  f"{len(d10)} chr22 PASS transitions converted to transversions. "
                  "Approximate: Tier-2 band is calibrated later.")

    # --- Defect 1: retired ancestry term (rename nfe -> oth) on ALL records ---
    d1 = [i for i, r in enumerate(records) if not r.drop]
    for i in d1:
        rename_nfe_to_oth(records[i])
    record_defect(1, "Retired ancestry term", ["fields.retired-terms"], 1, d1,
                  "nfe strata relabeled 'oth' (a retired gnomAD term) in every "
                  "INFO key + header. Applies file-wide by nature of the schema.")

    # Emit: drop flagged records, keep contig blocks grouped + position-sorted.
    kept = [r for r in records if not r.drop]
    kept.sort(key=lambda r: (CONTIG_RANK.get(r.contig, 99), r.pos))

    out_header = transform_header(header, drop_chry=True)
    with open(OUT_VCF, "w") as out:
        out.writelines(out_header)
        for r in kept:
            out.write(r.serialize())

    print(f"wrote {len(kept)} records to {OUT_VCF} "
          f"(dropped {len(records) - len(kept)} chrY)", file=sys.stderr)

    manifest = {
        "source_fixture": "partner-clean.vcf.bgz",
        "output_fixture": "partner-broken.vcf.bgz",
        "n_records_clean": len(records),
        "n_records_broken": len(kept),
        "params": {"n_per_arith_defect": N_PER_ARITH_DEFECT,
                   "n_titv_flip": N_TITV_FLIP, "common_af": COMMON_AF},
        # Checks that legitimately do NOT PASS on the *clean* fixture because it
        # is a small regional subset of real data rather than a whole genome.
        # run_checks.py treats a non-pass here as expected, not a regression.
        "clean_caveats": [
            {"check": "complete.chromosomes",
             "reason": "regional fixture carries only chr1/17/21/22/X/Y, not all "
                       "autosomes; genome-completeness is calibration-dependent."},
            {"check": "bio.titv",
             "reason": "regional PASS Ti/Tv ~1.75 sits below the genome-wide WGS "
                       "band (2.0-2.1); Tier-2 bands are methods-team-calibrated."},
        ],
        "defects": sorted(defects, key=lambda d: d["defect"]),
    }
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote defect manifest -> {MANIFEST}", file=sys.stderr)

    if not args.no_compress:
        with open(OUT_BGZ, "wb") as fh:
            subprocess.run(["bgzip", "-c", OUT_VCF], stdout=fh, check=True)
        os.remove(OUT_VCF)
        subprocess.run(["tabix", "-p", "vcf", OUT_BGZ], check=True)
        print(f"compressed -> {OUT_BGZ} (+ .tbi)", file=sys.stderr)


if __name__ == "__main__":
    main()
