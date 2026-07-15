//! Individual QC checks. Each check is one module implementing
//! [`Check`](crate::commands::qc::framework::Check) for its state, exporting a
//! `META` and a `new` constructor, and wired into
//! [`registry`](crate::commands::qc::framework::registry) with a single line.

pub mod biallelic;
pub mod complete_chromosomes;
pub mod contigs_grch38;
pub mod util;
