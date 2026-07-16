# CheckState Rust template

Fill this in to scaffold a new check. A check is **only** a `CheckState` variant + a registry
entry + a test. Do not touch the scan loop or the framework.

This template matches the framework as it actually landed in `01-scaffold`. The concrete,
compiling reference is **`backend/src/commands/qc/checks/biallelic.rs`** — copy its shape. The
module layout is:

```
backend/src/commands/qc/
  framework.rs        Status, Plot, CheckResult, CheckMeta, CheckConfig,
                      RegistryEntry, registry(), the Check trait, the CheckState
                      enum + its process_row/merge/finalize dispatch, QcAccumulator
  context.rs          ScanContext, Stratum
  checks/mod.rs       `pub mod <name>;` — one line per check
  checks/util.rs      shared helpers, e.g. `variant_id(row) -> String`
  checks/<name>.rs    ← YOUR CHECK: `pub const META` + the state struct + `impl Check`
```

> **Expectation bands are not wired yet.** There is no `ScanContext::expectation` /
> `qc.toml` plumbing in the framework as of `01-scaffold` (it's deferred — see the phased plan
> in `00-design-reference.md`). Until it lands, a check **inlines its threshold as a `const`**
> and still reports the measured value + an `expectation` JSON so the number is useful. If your
> check truly needs configurable bands now, stop and flag it — that's a framework change, not a
> check.

## 1. New file: `backend/src/commands/qc/checks/<name>.rs`

```rust
//! `<tier>.<name>` — <one-line description: what upstream failure this detects>.

use genohype_core::codec::EncodedValue;
use genohype_core::genomic::get_field;              // + get_nested_field / as_i32 / as_f64 as needed
use serde_json::json;

use super::util::{count_value, variant_id};         // variant_id: examples; count_value: AC/AN counts
use crate::commands::qc::context::ScanContext;
use crate::commands::qc::framework::{Check, CheckConfig, CheckMeta, CheckResult, Status};

/// Static metadata — powers `gbl qc list`, `--checks`, and tier selection.
pub const META: CheckMeta = CheckMeta {
    id: "<tier>.<name>",
    name: "<Human Name>",
    tier: <1|2|3>,
    category: "<schema|arithmetic|completeness|biological>",
    description: "<one line shown by `gbl qc list`>",
    needs: &[/* "globals" | "reference" | "consequences" */],
};

/// Running state — counts/sums only, bounded size. Not `Clone`.
pub struct <Name>State {
    // e.g. bins: [u64; 7], n_violations: u64
    examples: Vec<serde_json::Value>,
    max_examples: usize,
}

impl <Name>State {
    /// The cap comes from `CheckConfig`, NOT the context.
    pub fn new(cfg: &CheckConfig) -> Self {
        Self { examples: Vec::new(), max_examples: cfg.max_examples }
    }

    /// Push an example only while under the cap. Bounding here (and in `merge`)
    /// keeps memory O(checks), not O(variants).
    fn record_example(&mut self, example: serde_json::Value) {
        if self.examples.len() < self.max_examples {
            self.examples.push(example);
        }
    }
}

impl Check for <Name>State {
    /// Fold one variant record. Allocation-free on the hot path where reasonable.
    fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext) {
        // Sites-VCF layout: per-stratum counts are FLAT `info` fields, not a Hail
        // `freq` array. Read them via get_field + iterate the struct, e.g.:
        //   if let Some(EncodedValue::Array(alleles)) = get_field(row, "alleles") { ... }
        //   let Some(EncodedValue::Struct(info)) = get_field(row, "info") else { return };
        //   for (key, value) in info { /* "AC"/"AC_<suffix>"/"AN"/... */ }
        // Read AC/AN/nhomalt counts via count_value(value), NOT as_i32: a `Number=A`
        // field (AC) is a one-element array that as_i32 returns None for -> silent pass.
        // The freq_meta/freq_index_dict "globals" model is the FUTURE Hail path; on the
        // current fixtures a `needs: ["globals"]` check may find nothing and pass on nothing.
        // On a violation:
        //   self.record_example(json!({ "variant_id": variant_id(row), /* offending values */ }));
    }

    /// Combine two partials. MUST be associative + commutative (parallel reduce).
    fn merge(&mut self, other: Self) {
        // element-wise add your counters, then:
        for ex in other.examples { self.record_example(ex); }
    }

    /// Produce the CheckResult. Note: takes `self` by value.
    fn finalize(self, _ctx: &ScanContext) -> CheckResult {
        const _BAND: (f64, f64) = (0.0, 0.0);  // inline threshold until qc.toml lands
        let status = /* Tier 1 -> Pass/Fail ; Tier 2 -> Pass/Warn */ Status::Pass;
        CheckResult {
            // Pull identity straight from META so it can't drift:
            id: META.id.to_string(),
            name: META.name.to_string(),
            tier: META.tier,
            category: META.category.to_string(),
            status,
            metric: json!({ /* the numbers */ }),
            message: format!("..."),
            n_violations: /* .. */ 0,
            examples: self.examples,          // moved, not cloned (finalize owns self)
            expectation: Some(json!({ /* the rule/band, reported regardless */ })),
            plot: None,                       // or Some(Plot { kind, title, data })
            needs: META.needs.iter().map(|s| s.to_string()).collect(),
        }
    }
}
```

## 2. Wire into the enum + registry (both in `framework.rs`)

```rust
use super::checks::<name>::{self, <Name>State};   // top of framework.rs, with the others

pub enum CheckState {
    Biallelic(BiallelicState),
    <Name>(<Name>State),                          // add your variant
}

impl CheckState {
    fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext) {
        match self {
            CheckState::Biallelic(s) => s.process_row(row, ctx),
            CheckState::<Name>(s) => s.process_row(row, ctx),   // add arm
        }
    }
    fn merge(&mut self, other: CheckState) {
        match (self, other) {
            (CheckState::Biallelic(a), CheckState::Biallelic(b)) => a.merge(b),
            (CheckState::<Name>(a), CheckState::<Name>(b)) => a.merge(b),   // add arm
            _ => unreachable!("mismatched CheckState variants in merge"),
        }
    }
    fn finalize(self, ctx: &ScanContext) -> CheckResult {
        match self {
            CheckState::Biallelic(s) => s.finalize(ctx),
            CheckState::<Name>(s) => s.finalize(ctx),           // add arm
        }
    }
}

// One line in registry() so --checks and `gbl qc list` resolve the id:
pub fn registry() -> Vec<RegistryEntry> {
    vec![
        RegistryEntry { meta: biallelic::META,
                        construct: |cfg| CheckState::Biallelic(BiallelicState::new(cfg)) },
        RegistryEntry { meta: <name>::META,
                        construct: |cfg| CheckState::<Name>(<Name>State::new(cfg)) },   // add
    ]
}
```

And add `pub mod <name>;` to `backend/src/commands/qc/checks/mod.rs`.

> When `(self, other)` in `merge` gains a third variant, the `_ => unreachable!()` arm keeps the
> match total. Every accumulator is built from the same selection in the same order, so like is
> always merged with like — the arm never actually fires.

## 3. Unit test (from the spec's acceptance criteria)

Put it in a `#[cfg(test)] mod tests` at the bottom of your `checks/<name>.rs` (see
`biallelic.rs`). There is **no** `ScanContext::test_default()` — build one with a struct literal.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn ctx() -> ScanContext {
        ScanContext {
            reference_genome: "GRCh38".to_string(),
            freq_meta: Vec::new(),
            freq_index_dict: HashMap::new(),
            strata: Vec::new(),
        }
    }

    // build minimal synthetic rows as EncodedValue::Struct — see biallelic.rs `row()`

    #[test]
    fn <name>_pass_and_fail() {
        let cfg = CheckConfig { max_examples: 20 };
        let ctx = ctx();

        // PASS case
        let mut a = <Name>State::new(&cfg);
        for row in pass_rows() { a.process_row(&row, &ctx); }
        assert_eq!(a.finalize(&ctx).status, Status::Pass);

        // FAIL / WARN case — assert on a fresh state (finalize consumes self)
        let mut b = <Name>State::new(&cfg);
        for row in bad_rows() { b.process_row(&row, &ctx); }
        assert_ne!(b.finalize(&ctx).status, Status::Pass);
    }

    // Recommended: prove split-then-merge == whole via QcAccumulator, matching the
    // scaffold's `accumulator_folds_merges_and_flags_multiallelic` test. `finalize`
    // returns ALL selected checks' results — look yours up by id, never by index:
    //   let r = results.iter().find(|r| r.id == META.id).expect("result present");
    // Hard-coding results[0] / results.len() == 1 breaks when another check registers.
}
```

## 4. Integration coverage (the shared broken fixture)

The unit test above proves correctness in isolation. To also prove the check
fires end-to-end, make the shared broken fixture trip it — add a defect to the
mutator instead of committing a new VCF:

```python
# examples/federation/make_broken.py — add a defect that trips this check,
# then: uv run examples/federation/make_broken.py  (rewrites the fixture + defects.json)
dN = claim(st, records, chr1_idx, <predicate>, N_PER_ARITH_DEFECT)   # pick records
for i in dN:
    ...                                                              # inject the distortion
record_defect(<N>, "<Human name>", ["<tier>.<name>"], <tier>, dN, "<how injected>")
```

`run_checks.py` and the CI Rust test are manifest-driven, so this one entry gives
the check integration coverage automatically. If the check should PASS on the
clean fixture but can't (small regional subset), add its id to `clean_caveats`
with a reason instead. See `docs/spec/qc/05-fixtures-and-testing.md`.

## Checklist

- [ ] New `checks/<name>.rs` with `pub const META`, state struct, `impl Check`.
- [ ] `pub mod <name>;` added to `checks/mod.rs`.
- [ ] `CheckState::<Name>` variant + arms in all three `match`es in `framework.rs`.
- [ ] `registry()` entry present → shows in `gbl qc list`.
- [ ] Identity fields on `CheckResult` sourced from `META` (no re-typed literals).
- [ ] `process_row` allocation-free; examples bounded by `max_examples` (via `record_example`).
- [ ] `merge` associative + commutative.
- [ ] Threshold inlined as a `const` (no `ctx.expectation` — not wired yet).
- [ ] AC/AN/nhomalt counts read via `count_value`, not `as_i32` (no `Number=A` false-pass).
- [ ] Unit test asserts PASS and FAIL/WARN; ideally split-then-merge == whole. Results looked
      up by id (`find(|r| r.id == META.id)`), not index.
- [ ] `defects.json` checked first: reuse an existing defect if one already trips the check;
      otherwise add one to `make_broken.py` (or a documented `clean_caveats` / `--scenario`)
      and regenerate `defects.json`.
- [ ] No new dependencies; no scan-loop/framework-mechanism edits.
- [ ] `cargo test` green; `cargo clippy` clean on the new file.
