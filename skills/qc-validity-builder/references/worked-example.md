# Worked example: description → diff

A full pass through the skill, so you can see the expected granularity and hand-off.

## The user's description

> "Add a check for the transition/transversion ratio. Over biallelic SNVs, count transitions
> (A↔G, C↔T) versus transversions. For whole-genome data it should be about 2.0 to 2.1 — much
> lower means they didn't filter sequencing artifacts. Make it a WARN with a small bar plot."

## Step 1 — interview (fill the 8 fields)

| field | value |
|-------|-------|
| id / name | `bio.titv` / "Ti/Tv ratio" |
| tier | 2 (WARN) |
| detects | poor/absent variant filtering (artifacts are ~random, depressing Ti/Tv) |
| formula | over biallelic SNVs: `n_transition / n_transversion`; transition = {A↔G, C↔T} |
| needs | — (record-only) |
| band | WGS 2.0–2.1 (`qc.toml` `expectations.wgs.titv`); exome 2.8–3.2 |
| plot | bar (transition vs transversion counts) |
| gnomad_methods | `is_transition`/`is_transversion`; metric `r_ti_tv` |

Confirm the band with the user; it's the one number only they can validate.

## Step 2 — spec file

Create `docs/spec/qc/05-titv.md` by cloning `04-sfs.md`, filling each section with the above.
Ask the user to read it before touching Rust.

## Step 3 — the diff (sketch)

```rust
#[derive(Clone)]
pub struct TiTvState { transitions: u64, transversions: u64 }

impl TiTvState {
    pub fn new(_ctx: &ScanContext) -> Self { Self { transitions: 0, transversions: 0 } }

    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        let alleles = /* get_field(row, "alleles") as Array<Binary> */;
        if alleles.len() != 2 { return; }
        let (r, a) = (allele_str(&alleles[0]), allele_str(&alleles[1]));
        if r.len() != 1 || a.len() != 1 { return; }           // SNVs only
        if is_transition(r, a) { self.transitions += 1 } else { self.transversions += 1 }
    }

    fn merge(&mut self, o: Self) {
        self.transitions += o.transitions;
        self.transversions += o.transversions;
    }

    fn finalize(&self, ctx: &ScanContext) -> CheckResult {
        let ratio = self.transitions as f64 / self.transversions.max(1) as f64;
        let band = ctx.expectation("titv");
        let status = if band.contains(ratio) { Status::Pass } else { Status::Warn };
        CheckResult {
            id: "bio.titv".into(), name: "Ti/Tv ratio".into(),
            tier: 2, category: "biological".into(), status,
            metric: json!({ "ti_tv": ratio, "transitions": self.transitions,
                            "transversions": self.transversions }),
            message: format!("Ti/Tv {:.2} (expected {})", ratio, band.describe()),
            n_violations: 0,
            examples: vec![],
            expectation: Some(json!({ "titv": band })),
            plot: Some(Plot { kind: "titv_bar".into(),
                data: json!({ "labels": ["transition","transversion"],
                              "counts": [self.transitions, self.transversions] }) }),
            needs: vec![],
        }
    }
}

fn is_transition(r: &str, a: &str) -> bool {
    matches!((r, a), ("A","G")|("G","A")|("C","T")|("T","C"))
}
```

Plus: a `CheckState::TiTv` variant + match arms; a registry entry
(`register("bio.titv", ...)`); the `qc.toml` `titv` key; and a unit test with a few transition
and transversion SNVs asserting the ratio and a PASS (in band) and WARN (out of band).

Integration coverage already exists for this one: `make_broken.py` defect 10 flips chr22 PASS
transitions to transversions to depress Ti/Tv, and `defects.json` maps it to `bio.titv` — so
`run_checks.py` picks the check up the moment it's implemented. (`bio.titv` is also a
`clean_caveat`: the regional clean fixture's Ti/Tv ~1.75 sits below the WGS band, which is
expected, not a regression.) A brand-new check would add its own defect entry here.

## Step 4 — hand back

> "Here's `docs/spec/qc/05-titv.md` and the diff adding `bio.titv`. Please check the transition
> set `{A↔G, C↔T}` and the WGS band `2.0–2.1` — those are the science. To verify:
> `cargo test`, then `gbl qc list` (you'll see `bio.titv`), then
> `gbl qc run examples/federation/partner-clean.vcf.bgz --checks bio.titv --out r.json`, and
> open `/qc` — the Ti/Tv card lights up with the bar plot."

Note the scope discipline: one check, one spec, one PR, no framework changes.
