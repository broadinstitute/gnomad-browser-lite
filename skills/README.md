# Skills catalog

Skills are organized **by pipeline step** and tagged **operator** (drive the tool) vs
**developer** (build the tool). 

## Operator skills (user-facing — the "skill per step" story)

| Pipeline step | Skill | Repo | Status |
|---------------|-------|------|--------|
| Provision compute | `gh-cluster` | genohype | exists (publish) |
| Diagnose compute | `pool-analyzer` | genohype | exists (publish) |
| Ingest / export | *(future)* | genohype | roadmap |
| **Verify a submission** | [`qc-validity-federation-user`](qc-validity-federation-user/SKILL.md) | gnomad-browser-lite | ✅ new |
| **Extend the checks** | [`qc-validity-builder`](qc-validity-builder/SKILL.md) | gnomad-browser-lite | ✅ new (flagship) |
| Browse / interpret | [`variant-interpreter`](variant-interpreter/SKILL.md), [`gene-constraint-analyzer`](gene-constraint-analyzer/SKILL.md) | gnomad-browser-lite | exists |

**Connective tissue:** `qc-validity-builder` scaffolds a check → `qc-validity-federation-user` runs it and interprets
the report → if the sites file is huge, both hand off to `gh-cluster` / `pool-analyzer` to run
the scan on a distributed pool. One pipeline, a skill at each step.

## The QC skills (this repo)

- **[`qc-validity-federation-user`](qc-validity-federation-user/SKILL.md)** — run `gbl qc` on a sites-only submission and interpret
  the report (problem → fingerprint → likely upstream cause → accept/investigate/reject).
- **[`qc-validity-builder`](qc-validity-builder/SKILL.md)** — the flagship: a methods-team domain expert
  describes a new validity check; the skill produces a spec + a small Rust diff (a `CheckState`
  variant + registry entry + unit test); the expert reviews the diff. *Extending production
  infrastructure without writing Rust from scratch.* See `docs/spec/qc/` and its `references/`.

## Developer / maintainer skills (inward-facing)

Not part of the user story — the team's own tooling for building genohype: `pool-developer`,
`genohype-profiler`, `refactor-coordinator`, `concept-writer` (in the genohype repo). Listed for
completeness; a footnote, not the headline.

## See also

- `docs/spec/qc/README.md` — the validity-check specs and the "add a check in 30 minutes"
  onboarding.
- `examples/federation/` — the clean + broken sites-only fixtures the skills demo against.
