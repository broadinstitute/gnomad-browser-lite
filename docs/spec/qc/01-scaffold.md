# 01 — Scaffold: `gbl qc` command + accumulator framework

**Owner:** core team (Rust). **Depends on:** nothing. **Blocks:** `02`, and every check spec.
**One PR.**

The infrastructure PR. It ships the command, the accumulator pattern, the report contract, and
**one trivial check end-to-end** to prove the whole pipe — but no real check logic. After this,
adding a check is purely additive (a new `CheckState` variant + registry line).

## Deliverables

1. **CLI**: add `Qc` to the `Commands` enum in `backend/src/cli.rs` with the `list` / `run`
   subcommands and the flags from `00-design-reference.md` (`run` needs at least `<source>`,
   `--checks`, `--tier`, `--out`, `--max-examples`, `--fail-on`). Dispatch in `main.rs`.
2. **Handler**: `backend/src/commands/qc.rs`, mirroring `commands/validate.rs`
   (`spawn_blocking(QueryEngine::open_path)`, partition scan).
3. **Framework**:
   - `CheckResult` struct + `Status` enum + `Plot` type, all `serde` (schema in `00`).
   - `QcAccumulator { states: Vec<CheckState> }` with `new(selected, ctx)`, `process_row`,
     `merge`, `finalize(ctx) -> Vec<CheckResult>`.
   - `CheckState` enum + a **registry**: `id -> (metadata, constructor)` so `--checks` /
     `gbl qc list` resolve ids, and `qc list` prints id/tier/description/needs.
   - `ScanContext` with `globals`/`strata` parsing (from `engine.globals()`).
4. **The parallel scan** (fold/reduce from `00`) wired into `run`, writing `report.json`
   (stamp `generated_at`, `rows_scanned`, `summary` counts) or stdout.
5. **One trivial check** to exercise the pipe end-to-end: `fields.biallelic`
   (`status = Fail` if any row has `len(alleles) != 2`). Chosen because it needs no globals and
   no reference — the simplest possible real check.
6. **`gbl qc list`** prints the registry (just the one check for now).

## Acceptance criteria

- [ ] `gbl qc list` prints `fields.biallelic` with tier/category/description.
- [ ] `gbl qc run examples/federation/partner-clean.vcf.bgz --out r.json` writes a valid
      report (`schema_version:"1"`, populated `summary`, one check) and exits 0.
- [ ] Running on a file with a multiallelic row yields `status:"fail"` with bounded `examples`
      and exit 1 (default `--fail-on fail`).
- [ ] A unit test drives `QcAccumulator` over a tiny in-memory fixture: fold two partitions,
      `merge`, `finalize`, assert the `CheckResult`.
- [ ] `cargo test` green; no clippy regressions.

## Design notes for contributors

- Keep `process_row` allocation-free on the hot path where reasonable; `merge` must be
  associative and commutative (it runs in a parallel reduce).
- Bound `examples` at `--max-examples` inside `process_row`/`merge` so memory is O(checks),
  not O(variants).
- Do **not** add per-check binaries or branches in the scan loop; a check is only a
  `CheckState` variant. This is what lets `qc-validity-builder` add checks mechanically.
