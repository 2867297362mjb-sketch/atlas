//! The editor gutter's view of a file's `git diff`: which lines of the new
//! file are added, which are changed, and which follow a removal.
//!
//! [`line_status`] is the whole interface. Behind it are a unified-diff
//! parser (`parse`) and the line pairing that tells a changed line from an
//! added one, vendored from `dandavison/delta` — see `src/vendor/` and
//! `LICENSE-delta`.

mod engine;
mod parse;
mod vendor;

pub use engine::{line_status, LineStatus};
