//! What Atlas does to a repository: the source-control surface's branch,
//! sync, stash, history and commit rules, as plain blocking functions over
//! [`GitCommand`].
//!
//! A [`Repository`] is a path and whoever must hear that it changed. The
//! file watcher cannot see everything a git command moves (a ref update
//! touches no working-tree file), so a mutation tells the injected
//! [`ChangeNotifier`], and the app passes one that emits its event. Nothing
//! here knows about Tauri, which is what lets `tests/repository.rs` drive
//! every rule against a real temporary repository.
//!
//! The rule for the notifier, kept by every method below: it is told when a
//! command that can move the repository has run, and never by a read or by a
//! command refused before it ran. Each mutating method's doc says whether a
//! failure still notifies.

use std::path::{Path, PathBuf};

use crate::error::GitErrorPayload;
use crate::exec::{GitCommand, OpSink, Stream};

mod branches;
mod commit;
mod history;
mod sync;
mod worktree;

pub use branches::{BranchInfo, MergePreview, MergePreviewKind};
pub use commit::CommitRequest;
pub use history::{CommitDetail, InProgress, InProgressKind, OpAction, ResetMode};
pub use sync::{PullPreference, PullStrategy, PushOptions, RemoteInfo};
pub use worktree::StashEntry;

/// Unit separator for `--format` parsing.
const US: char = '\u{1f}';

type Result<T> = std::result::Result<T, GitErrorPayload>;

/// Hears that a repository changed in a way the file watcher may not see.
pub trait ChangeNotifier: Sync {
    fn changed(&self, repo: &Path);
}

impl<F: Fn(&Path) + Sync> ChangeNotifier for F {
    fn changed(&self, repo: &Path) {
        self(repo);
    }
}

/// For a caller that only reads: nobody to tell.
impl ChangeNotifier for () {
    fn changed(&self, _repo: &Path) {}
}

/// Watches one long operation (a fetch, a push, a commit and its hooks):
/// its start, its output as it arrives, and its end.
///
/// The order is fixed: `started`, then any number of `output` and
/// `progress`, then the [`ChangeNotifier`], then `finished`. An operation
/// that returns before it could run git at all (a failed preparation step)
/// ends without `finished`; the observer's owner closes it.
pub trait OpObserver: Sync {
    fn started(&self);
    fn output(&self, stream: Stream, line: &str);
    /// `fraction` is 0.0 to 1.0 across the whole operation; `title` names
    /// the step git is on.
    fn progress(&self, fraction: f32, title: &str);
    /// `error` is the failure exactly as git reported and this crate
    /// classified it.
    fn finished(&self, error: Option<&GitErrorPayload>);
}

/// An [`OpObserver`] as the executor's line sink.
struct Lines<'a>(&'a dyn OpObserver);

impl OpSink for Lines<'_> {
    fn output(&self, stream: Stream, line: &str) {
        self.0.output(stream, line);
    }
}

/// One repository, and who hears that it changed.
pub struct Repository<'a> {
    path: PathBuf,
    notifier: &'a dyn ChangeNotifier,
    envs: Vec<(String, String)>,
}

impl<'a> Repository<'a> {
    pub fn new(path: impl Into<PathBuf>, notifier: &'a dyn ChangeNotifier) -> Self {
        Repository {
            path: path.into(),
            notifier,
            envs: Vec::new(),
        }
    }

    /// One more variable on every git this repository runs, on top of the
    /// standard environment. The tests use it to shut out the developer's
    /// own git config and to fix an identity.
    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.envs.push((key.to_string(), value.to_string()));
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn git(&self, args: &[&str]) -> GitCommand {
        self.with_envs(GitCommand::new(&self.path, args))
    }

    fn with_envs(&self, mut cmd: GitCommand) -> GitCommand {
        for (k, v) in &self.envs {
            cmd = cmd.env(k, v);
        }
        cmd
    }

    /// Run git here and return stdout; a failure is classified.
    fn out(&self, args: &[&str]) -> Result<String> {
        Ok(self.git(args).run()?.stdout)
    }

    /// [`out`](Self::out) for a command that changes the repository: the
    /// notifier hears of it once it has succeeded.
    fn mutate(&self, args: &[&str]) -> Result<String> {
        let out = self.out(args)?;
        self.changed();
        Ok(out)
    }

    fn changed(&self) {
        self.notifier.changed(&self.path);
    }

    /// `git <args>`, keeping stdout when it exits 0. Exit 1 is "unset" for
    /// `config --get` and "detached" for `symbolic-ref --quiet`.
    fn read_value(&self, args: &[&str]) -> Option<String> {
        self.git(args)
            .read_only()
            .success_codes(&[0, 1])
            .run()
            .ok()
            .filter(|o| o.exit_code == 0)
            .map(|o| o.stdout.trim().to_string())
    }
}

/// Refuse a branch name git would read as an option. `git check-ref-format`
/// refuses one too, but only after git has already parsed it as a flag.
fn branch_arg(branch: &str) -> Result<&str> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(GitErrorPayload::internal(format!(
            "'{branch}' is not a branch name."
        )));
    }
    Ok(branch)
}
