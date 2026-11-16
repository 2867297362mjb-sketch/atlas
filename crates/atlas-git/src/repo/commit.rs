//! The streamed commit: message over stdin, hooks run and heard, typed
//! failures.

use std::path::Path;

use super::{Lines, OpObserver, Repository, Result};
use crate::error::{self, GitErrorCode};
use crate::exec::GitCommand;

/// What [`Repository::commit`] is asked to commit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitRequest {
    pub summary: String,
    pub description: Option<String>,
    /// Amend the last commit. With an empty `summary` the original message
    /// is kept.
    pub amend: bool,
    /// `Name <email>` strings, added as `Co-authored-by` trailers.
    pub co_authors: Vec<String>,
}

/// A commit message: the trimmed summary, a blank line and the trimmed
/// description when there is one, and a final newline.
pub(super) fn message(summary: &str, description: Option<&str>) -> String {
    let mut message = summary.trim().to_string();
    if let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) {
        message.push_str("\n\n");
        message.push_str(d);
    }
    message.push('\n');
    message
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

impl Repository<'_> {
    /// Does this repository have any commit-phase hooks? Used to classify an
    /// otherwise-unrecognized commit failure as `hook-failed` — git prints no
    /// stable marker when a hook rejects, but if hooks exist and the commit
    /// died unclassified, the hook is by far the likeliest cause.
    fn commit_hooks_present(&self) -> bool {
        let hooks_dir = match self
            .read_value(&["config", "--get", "core.hooksPath"])
            .filter(|d| !d.is_empty())
        {
            Some(d) => d,
            None => match self
                .git(&["rev-parse", "--git-path", "hooks"])
                .read_only()
                .run()
            {
                Ok(o) => o.stdout.trim().to_string(),
                Err(_) => return false,
            },
        };
        if hooks_dir.is_empty() {
            return false;
        }
        let base = Path::new(&hooks_dir);
        let base = if base.is_absolute() {
            base.to_path_buf()
        } else {
            self.path().join(base)
        };
        [
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
        ]
        .iter()
        .any(|h| {
            let hp = base.join(h);
            hp.is_file() && is_executable(&hp)
        })
    }

    /// Commit what is staged. The message goes to `commit -F -` over stdin
    /// (multiline-safe). Hooks run — this is the real git binary and
    /// `--no-verify` is never passed — and their output reaches the observer
    /// as it is printed instead of being swallowed.
    ///
    /// Co-authors are merged as `Co-authored-by` trailers by
    /// `git interpret-trailers`, which places them and drops any the
    /// description already carries. Amending with an empty summary keeps the
    /// original message (`--amend --no-edit`).
    ///
    /// A failure git did not explain, in a repository that has commit hooks,
    /// is reported as `hook-failed`. The notifier is told after the commit
    /// ran whether or not it succeeded: the index and HEAD may have moved
    /// even then (a post-commit hook failing after the commit landed).
    pub fn commit(&self, request: CommitRequest, observer: &dyn OpObserver) -> Result<()> {
        observer.started();
        let sink = Lines(observer);
        let keep_message = request.amend && request.summary.trim().is_empty();

        let result = if keep_message {
            self.git(&["commit", "--amend", "--no-edit"])
                .run_streaming(&sink)
        } else {
            let mut message = message(&request.summary, request.description.as_deref());

            let authors: Vec<String> = request
                .co_authors
                .iter()
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            if !authors.is_empty() {
                let mut targs: Vec<String> =
                    vec!["interpret-trailers".into(), "--no-divider".into()];
                for a in &authors {
                    targs.push("--trailer".into());
                    targs.push(format!("Co-authored-by={a}"));
                }
                message = self
                    .with_envs(GitCommand::new_owned(self.path(), targs))
                    .stdin(message.into_bytes())
                    .run()?
                    .stdout;
            }

            let mut args = vec!["commit", "-F", "-"];
            if request.amend {
                args.push("--amend");
            }
            self.git(&args)
                .stdin(message.into_bytes())
                .run_streaming(&sink)
        };

        self.changed();

        match result {
            Ok(_) => {
                observer.finished(None);
                Ok(())
            }
            Err(mut e) => {
                if e.code == GitErrorCode::Generic && self.commit_hooks_present() {
                    e.code = GitErrorCode::HookFailed;
                    e.message = error::friendly_message(GitErrorCode::HookFailed, &[], None);
                }
                observer.finished(Some(&e));
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::message;

    #[test]
    fn a_message_is_the_summary_then_the_description_then_a_newline() {
        assert_eq!(message("  fix it  ", None), "fix it\n");
        assert_eq!(message("fix it", Some("   ")), "fix it\n");
        assert_eq!(message("fix it", Some("\nwhy\n")), "fix it\n\nwhy\n");
    }
}
