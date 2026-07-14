# CheckState Rust template

Fill this in to scaffold a new check. A check is **only** a `CheckState` variant + a registry
entry + a test. Do not touch the scan loop or the framework. Names below are placeholders —
match the actual types in `backend/src/commands/qc.rs` once `01-scaffold` lands (this template
tracks the design in `docs/spec/qc/00-design-reference.md`).

## 1. State + the three methods

```rust
/// <one-line description — what upstream failure this detects>
#[derive(Clone)]
pub struct <Name>State {
    // accumulator fields — counts/sums only, bounded size
    // e.g. bins: [u64; 7], n: u64, examples: Vec<serde_json::Value>
}

impl <Name>State {
    pub fn new(_ctx: &ScanContext) -> Self { Self { /* zeroed */ } }

    /// Fold one variant record. Allocation-free on the hot path.
    fn process_row(&mut self, row: &EncodedValue, ctx: &ScanContext) {
        // read fields via extract helpers:
        //   let alleles = get_field(row, "alleles")...;           // biallelic: len == 2
        //   let (ac, an) = read global stratum from row.freq[ctx.strata.global_idx]
        //   let af = as_f64(get_nested_field(freq_i, "af"));
        // update accumulator; if a violation, push a bounded example (<= max_examples)
    }

    /// Combine two partials. MUST be associative + commutative (parallel reduce).
    fn merge(&mut self, other: Self) {
        // element-wise add; extend examples up to the cap
    }

    /// Produce the CheckResult (compute metric, compare to band, build message + plot).
    fn finalize(&self, ctx: &ScanContext) -> CheckResult {
        let band = ctx.expectation("<qc.toml key>");   // measured value reported regardless
        let status = /* Tier 1 -> Pass/Fail ; Tier 2 -> Pass/Warn */;
        CheckResult {
            id: "<tier>.<name>".into(),
            name: "<Human Name>".into(),
            tier: <1|2|3>,
            category: "<schema|arithmetic|completeness|biological>".into(),
            status,
            metric: serde_json::json!({ /* the numbers */ }),
            message: format!("..."),
            n_violations: /* .. */,
            examples: self.examples.clone(),
            expectation: Some(serde_json::json!({ /* band */ })),
            plot: Some(Plot { /* type + small summary data */ }),  // or None
            needs: vec![/* "globals" | "reference" | "consequences" */],
        }
    }
}
```

## 2. Wire into the enum + registry

```rust
enum CheckState {
    // ...existing variants...
    <Name>(<Name>State),
}

// dispatch in QcAccumulator::process_row / merge / finalize (match arm per variant)

// registry entry so --checks and `gbl qc list` resolve the id:
register("<tier>.<name>", CheckMeta {
    name: "<Human Name>", tier: <n>, category: "<..>",
    needs: &[/* .. */], plot: Some("<plot_type>"),
    make: |ctx| CheckState::<Name>(<Name>State::new(ctx)),
});
```

## 3. Unit test (from the spec's acceptance criteria)

```rust
#[test]
fn <name>_pass_and_fail() {
    let ctx = ScanContext::test_default();
    // PASS case
    let mut a = <Name>State::new(&ctx);
    for row in synthetic_rows_pass() { a.process_row(&row, &ctx); }
    assert_eq!(a.finalize(&ctx).status, Status::Pass);
    // FAIL / WARN case
    let mut b = <Name>State::new(&ctx);
    for row in synthetic_rows_bad() { b.process_row(&row, &ctx); }
    assert_ne!(b.finalize(&ctx).status, Status::Pass);
    // merge is associative: fold split == fold whole
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

- [ ] `process_row` allocation-free; examples bounded by `max_examples`.
- [ ] `merge` associative + commutative.
- [ ] Registry entry present → shows in `gbl qc list`.
- [ ] `qc.toml` band key added if configurable.
- [ ] Unit test asserts PASS and FAIL/WARN and that split-then-merge == whole.
- [ ] Broken-fixture defect added to `make_broken.py` (or a documented `clean_caveats` /
      `--scenario`); `defects.json` regenerated.
- [ ] No new dependencies; no scan-loop/framework edits.
