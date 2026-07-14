#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""Run `gbl qc` against the federation fixtures and check the result against
`defects.json` — the human-facing mirror of the CI integration test.

What it asserts (all driven by the manifest, so it grows automatically as checks
and defects are added):

  clean fixture   every implemented check PASSes, except the ids listed in
                  `clean_caveats` (checks that legitimately can't pass on a small
                  regional subset of real data).
  broken fixture  every check named by a defect is in a failing state
                  (FAIL for Tier 1, FAIL or WARN for Tier 2); and no *other*
                  check fails unexpectedly (the false-positive guard).

Checks named in the manifest but not yet present in the report (not implemented
yet) are reported as SKIPPED, never failures — so this is useful from the very
first check through the full catalog.

`gbl qc` does not exist until `docs/spec/qc/01-scaffold.md` lands. Until then this
script SKIPs (exit 0) with a message, unless `--require` is passed.

Usage:
    uv run run_checks.py                      # uses `gbl`
    GBL='cargo run -q --bin backend --' uv run run_checks.py   # pre-rename dev build
    uv run run_checks.py --strict             # unexpected/false-positive fails -> exit 1
    uv run run_checks.py --require            # missing `gbl qc` -> error instead of skip
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CLEAN = os.path.join(HERE, "partner-clean.vcf.bgz")
BROKEN = os.path.join(HERE, "partner-broken.vcf.bgz")
MANIFEST = os.path.join(HERE, "defects.json")

GREEN, RED, YEL, DIM, RST = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


def run_report(gbl_argv, source, require):
    """Run `gbl qc run <source>` and return the parsed report dict, or None if
    the gbl command isn't available (unless --require)."""
    with tempfile.NamedTemporaryFile("r", suffix=".json", delete=False) as tf:
        out = tf.name
    argv = gbl_argv + ["qc", "run", source, "--out", out]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True)
    except FileNotFoundError:
        if require:
            sys.exit(f"{RED}gbl not found: {gbl_argv[0]}{RST}")
        print(f"{YEL}SKIP:{RST} `{gbl_argv[0]}` not found — `gbl qc` not built yet "
              f"(see docs/spec/qc/01-scaffold.md). Pass --require to make this an error.")
        return None
    if proc.returncode not in (0, 1):  # 0=all pass, 1=fail-on policy; both write a report
        sys.stderr.write(proc.stderr)
        sys.exit(f"{RED}gbl qc run exited {proc.returncode} for {source}{RST}")
    try:
        with open(out) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"{RED}could not read report for {source}: {e}{RST}")
    finally:
        os.unlink(out)


def status_of(report):
    """check id -> lowercased status from a report."""
    return {c["id"]: str(c.get("status", "")).lower() for c in report.get("checks", [])}


def nviol_of(report):
    return {c["id"]: c.get("n_violations", 0) for c in report.get("checks", [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gbl", default=os.environ.get("GBL", "gbl"),
                    help="gbl command (may include args); env GBL overrides. Default 'gbl'.")
    ap.add_argument("--strict", action="store_true",
                    help="treat unexpected clean warnings / broken false-positives as failures")
    ap.add_argument("--require", action="store_true",
                    help="error (not skip) if gbl is not available")
    args = ap.parse_args()
    gbl_argv = shlex.split(args.gbl)

    man = json.load(open(MANIFEST))
    caveats = {c["check"] for c in man.get("clean_caveats", [])}
    # check id -> (defect name, tier) it is expected to trip
    expected_fail = {}
    for d in man["defects"]:
        for cid in d["checks"]:
            expected_fail[cid] = (d["name"], d["tier"])

    clean = run_report(gbl_argv, CLEAN, args.require)
    if clean is None:
        return 0  # skipped
    broken = run_report(gbl_argv, BROKEN, args.require)

    cs, bs = status_of(clean), status_of(broken)
    bn = nviol_of(broken)
    problems = []   # hard failures
    warnings = []   # soft (only fail under --strict)

    # --- clean: everything implemented should PASS, except caveats ---
    print(f"\n{DIM}clean fixture ({os.path.basename(CLEAN)}):{RST}")
    for cid, st in sorted(cs.items()):
        if st == "pass":
            continue
        if cid in caveats:
            print(f"  {YEL}{st.upper():5}{RST} {cid}  {DIM}(known caveat){RST}")
        elif st == "fail":
            print(f"  {RED}{st.upper():5}{RST} {cid}  {RED}<- unexpected FAIL on clean{RST}")
            problems.append(f"clean: {cid} FAILed but is not a declared caveat")
        else:  # warn
            print(f"  {YEL}{st.upper():5}{RST} {cid}  {DIM}(unexpected warn){RST}")
            warnings.append(f"clean: {cid} WARNed unexpectedly")
    if all(st == "pass" or cid in caveats for cid, st in cs.items()):
        print(f"  {GREEN}all implemented checks pass (caveats aside){RST}")

    # --- broken: each expected check must be failing; guard false positives ---
    print(f"\n{DIM}broken fixture ({os.path.basename(BROKEN)}):{RST}")
    for cid, (dname, tier) in sorted(expected_fail.items()):
        st = bs.get(cid)
        ok = {1: {"fail"}, 2: {"fail", "warn"}}.get(tier, {"fail", "warn"})
        if st is None:
            print(f"  {DIM}SKIP  {cid}  (not implemented yet) [{dname}]{RST}")
        elif st in ok:
            print(f"  {GREEN}{st.upper():5}{RST} {cid}  n_violations={bn.get(cid)} [{dname}]")
        else:
            print(f"  {RED}{st.upper():5}{RST} {cid}  {RED}<- expected to fail [{dname}]{RST}")
            problems.append(f"broken: {cid} expected failing (tier {tier}) but was {st}")

    # false-positive guard: failing checks on broken not named by any defect
    for cid, st in sorted(bs.items()):
        if st in ("fail", "warn") and cid not in expected_fail and cid not in caveats:
            print(f"  {YEL}{st.upper():5}{RST} {cid}  {YEL}<- unexpected failure (false positive?){RST}")
            warnings.append(f"broken: {cid} failed but no defect targets it")

    # --- verdict ---
    if args.strict:
        problems += warnings
        warnings = []
    print()
    for w in warnings:
        print(f"{YEL}warn:{RST} {w}")
    if problems:
        for p in problems:
            print(f"{RED}FAIL:{RST} {p}")
        print(f"\n{RED}fixtures check FAILED ({len(problems)} problem(s)){RST}")
        return 1
    print(f"{GREEN}fixtures check PASSED{RST}"
          + (f" {DIM}({len(warnings)} soft warning(s); --strict to enforce){RST}" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
