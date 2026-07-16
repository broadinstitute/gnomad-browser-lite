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

New file `backend/src/commands/qc/checks/titv.rs` (see `checkstate-template.md` for the full
scaffold; imports and the `Check` trait shape come from there and from `biallelic.rs`):

```rust
pub const META: CheckMeta = CheckMeta {
    id: "bio.titv",
    name: "Ti/Tv ratio",
    tier: 2,
    category: "biological",
    description: "Transition/transversion ratio over biallelic SNVs.",
    needs: &[],
};

// Band is inlined for now — there is no ctx.expectation / qc.toml plumbing yet
// (deferred; see 00-design-reference.md). The measured ratio is still reported.
const WGS_TITV: (f64, f64) = (2.0, 2.1);

pub struct TiTvState { transitions: u64, transversions: u64 }

impl TiTvState {
    // The cap comes from CheckConfig even when this check keeps no examples.
    pub fn new(_cfg: &CheckConfig) -> Self { Self { transitions: 0, transversions: 0 } }
}

impl Check for TiTvState {
    fn process_row(&mut self, row: &EncodedValue, _ctx: &ScanContext) {
        let Some(EncodedValue::Array(alleles)) = get_field(row, "alleles") else { return };
        if alleles.len() != 2 { return; }
        let (Some(r), Some(a)) = (as_string(&alleles[0]), as_string(&alleles[1])) else { return };
        if r.len() != 1 || a.len() != 1 { return; }           // SNVs only
        if is_transition(&r, &a) { self.transitions += 1 } else { self.transversions += 1 }
    }

    fn merge(&mut self, o: Self) {
        self.transitions += o.transitions;
        self.transversions += o.transversions;
    }

    fn finalize(self, _ctx: &ScanContext) -> CheckResult {      // takes self by value
        let ratio = self.transitions as f64 / self.transversions.max(1) as f64;
        let (lo, hi) = WGS_TITV;
        let status = if (lo..=hi).contains(&ratio) { Status::Pass } else { Status::Warn };
        CheckResult {
            id: META.id.to_string(), name: META.name.to_string(),
            tier: META.tier, category: META.category.to_string(), status,
            metric: json!({ "ti_tv": ratio, "transitions": self.transitions,
                            "transversions": self.transversions }),
            message: format!("Ti/Tv {:.2} (expected {}-{})", ratio, lo, hi),
            n_violations: 0,
            examples: vec![],
            expectation: Some(json!({ "ti_tv": { "min": lo, "max": hi } })),
            plot: Some(Plot { kind: "bar".into(), title: "Ti/Tv".into(),
                data: json!({ "labels": ["transition","transversion"],
                              "counts": [self.transitions, self.transversions] }) }),
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}

fn is_transition(r: &str, a: &str) -> bool {
    matches!((r, a), ("A","G")|("G","A")|("C","T")|("T","C"))
}
```

Plus: `pub mod titv;` in `checks/mod.rs`; a `CheckState::TiTv(TiTvState)` variant + the three
match arms in `framework.rs`; a `registry()` entry
(`RegistryEntry { meta: titv::META, construct: |cfg| CheckState::TiTv(TiTvState::new(cfg)) }`);
and a unit test with a few transition and transversion SNVs asserting the ratio and a PASS (in
band) and WARN (out of band). No `qc.toml` key yet — the band lives in the `WGS_TITV` const
until the expectation API lands.

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
> `uv run examples/federation/run_checks.py` — the `bio.titv` line flips from SKIP to a verdict."

(The `/qc` page does not yet show a newly registered check — `/api/qc-report` isn't built,
so the page renders a static sample. `run_checks.py` is the end-to-end signal, not the UI.)

Note the scope discipline: one check, one spec, one PR, no framework changes.
