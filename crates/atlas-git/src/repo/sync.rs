//! Talking to remotes: fetch, pull, push, publish, and a branch rebase.
//!
//! Each of these takes an optional [`OpObserver`]. With one, the command
//! runs with its output streamed line by line, `--progress` lines turned
//! into a weighted percentage ([`crate::progress`]), and the notifier is
//! told whether it succeeded or not: a pull that stops on a conflict has
//! still moved the repository. Without one it runs buffered and notifies on
//! success only.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{Lines, OpObserver, Repository, Result};
use crate::error::{self, GitErrorCode, GitErrorPayload};
use crate::exec::{OpSink, Stream};
use crate::progress::{steps_for, ProgressParser};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// How `git pull` reconciles a branch that has diverged from its upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullStrategy {
    /// No flag — git's config decides (`pull.rebase` / `pull.ff`). Fails with
    /// `DivergentBranches` when the branch diverged and nothing is configured.
    #[default]
    Default,
    /// `--rebase`: replay local commits on top of the upstream's.
    Rebase,
    /// `--no-rebase`: merge the upstream in. Overrides `pull.ff=only` too.
    Merge,
}

/// What a plain `git pull` would do on a diverged branch, given git config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullPreference {
    /// Config says rebase: a plain pull reconciles on its own.
    Rebase,
    /// Config says merge: a plain pull reconciles on its own.
    Merge,
    /// Nothing configured, or `pull.ff=only`: a plain pull would refuse, so
    /// the user has to choose.
    Ask,
}

/// What [`Repository::push`] is asked to do beyond a plain push.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PushOptions<'a> {
    /// Overwrite the remote branch, but only over commits this branch has
    /// seen (`--force-with-lease --force-if-includes`).
    pub force_with_lease: bool,
    /// Send annotated tags reachable from what is pushed.
    pub follow_tags: bool,
    /// The remote to push to; git's default for the branch when `None`.
    pub remote: Option<&'a str>,
}

fn pull_args(strategy: PullStrategy, remote: Option<&str>) -> Vec<&str> {
    let mut args = vec!["pull", "--progress"];
    match strategy {
        PullStrategy::Default => {}
        PullStrategy::Rebase => args.push("--rebase"),
        PullStrategy::Merge => args.push("--no-rebase"),
    }
    if let Some(r) = remote {
        args.push(r);
    }
    args
}

/// `git push` arguments. No refspec: git pushes the current branch to its
/// upstream, and fails with `NoUpstream` when there is none — publishing a
/// branch is [`Repository::publish_branch`]'s job.
fn push_args(options: PushOptions<'_>) -> Vec<&str> {
    let mut args = vec!["push", "--progress"];
    if options.force_with_lease {
        // The lease alone compares against the remote-tracking ref, which
        // background auto-fetch moves without the user seeing it — so a
        // teammate's commit fetched a minute ago would pass. `--force-if-includes`
        // also requires that tip to have been part of this branch (its reflog).
        args.extend(["--force-with-lease", "--force-if-includes"]);
    }
    if options.follow_tags {
        args.push("--follow-tags");
    }
    if let Some(r) = options.remote {
        args.push(r);
    }
    args
}

/// git's own precedence, checked against git 2.54: `pull.ff=only` refuses
/// a diverged pull even when a rebase setting exists; otherwise
/// `branch.<name>.rebase` beats `pull.rebase` (false merges, any other value
/// — true, merges, interactive — rebases); otherwise any other `pull.ff`
/// value merges; otherwise git refuses.
fn resolve_pull_preference(
    branch_rebase: Option<&str>,
    pull_rebase: Option<&str>,
    pull_ff: Option<&str>,
) -> PullPreference {
    let ff = pull_ff.map(str::to_ascii_lowercase);
    if ff.as_deref() == Some("only") {
        return PullPreference::Ask;
    }
    if let Some(rebase) = branch_rebase.or(pull_rebase) {
        return match rebase.to_ascii_lowercase().as_str() {
            "false" | "no" | "off" | "0" | "" => PullPreference::Merge,
            _ => PullPreference::Rebase,
        };
    }
    if ff.is_some() {
        return PullPreference::Merge;
    }
    PullPreference::Ask
}

/// Forwards output lines to the observer and feeds them through a weighted
/// progress parser, reporting `progress` as the percentage advances.
struct ProgressSink<'a> {
    observer: &'a dyn OpObserver,
    parser: Mutex<ProgressParser>,
}

impl OpSink for ProgressSink<'_> {
    fn output(&self, stream: Stream, line: &str) {
        Lines(self.observer).output(stream, line);
        if let Ok(mut parser) = self.parser.lock() {
            if let Some((fraction, title)) = parser.advance(line) {
                self.observer.progress(fraction, &title);
            }
        }
    }
}

impl Repository<'_> {
    /// One remote operation. `kind` picks the progress steps (`fetch`,
    /// `pull`, `push`, `rebase`).
    fn remote_op(
        &self,
        kind: &str,
        args: &[&str],
        observer: Option<&dyn OpObserver>,
    ) -> Result<String> {
        let Some(observer) = observer else {
            return self.mutate(args);
        };
        observer.started();
        let sink = ProgressSink {
            observer,
            parser: Mutex::new(ProgressParser::new(&steps_for(kind))),
        };
        let result = self.git(args).run_streaming(&sink);
        self.changed();
        match result {
            Ok(o) => {
                observer.finished(None);
                Ok(o.stdout)
            }
            Err(e) => {
                observer.finished(Some(&e));
                Err(e)
            }
        }
    }

    /// Fetch every remote, pruning branches deleted there.
    pub fn fetch(&self, observer: Option<&dyn OpObserver>) -> Result<String> {
        self.remote_op(
            "fetch",
            &["fetch", "--all", "--prune", "--progress"],
            observer,
        )
    }

    /// Pull the current branch. A branch that diverged with nothing
    /// configured fails as `divergent-branches` under
    /// [`PullStrategy::Default`]; see [`pull_preference`](Self::pull_preference).
    pub fn pull(
        &self,
        strategy: PullStrategy,
        remote: Option<&str>,
        observer: Option<&dyn OpObserver>,
    ) -> Result<String> {
        self.remote_op("pull", &pull_args(strategy, remote), observer)
    }

    /// What a plain pull would do on a diverged branch, from the effective
    /// (repo → global → system) config. Read before pulling, so the user is
    /// only asked "rebase or merge?" when git itself would refuse — never
    /// over a saved preference.
    pub fn pull_preference(&self) -> PullPreference {
        let get = |key: &str| self.read_value(&["config", "--get", key]);
        let branch_rebase = self
            .read_value(&["symbolic-ref", "--quiet", "--short", "HEAD"])
            .filter(|b| !b.is_empty())
            .and_then(|b| get(&format!("branch.{b}.rebase")));
        resolve_pull_preference(
            branch_rebase.as_deref(),
            get("pull.rebase").as_deref(),
            get("pull.ff").as_deref(),
        )
    }

    /// Push the current branch to its upstream.
    ///
    /// A non-fast-forward rejection is one of two things, and they want
    /// opposite fixes: the remote has work you don't (pull), or you rewrote
    /// commits you had already pushed (force-push — pulling would merge the
    /// old copies back in). The second comes back as `history-rewritten`.
    /// The observer's `finished` still carries the rejection as git worded
    /// it; only the returned error is recoded.
    pub fn push(
        &self,
        options: PushOptions<'_>,
        observer: Option<&dyn OpObserver>,
    ) -> Result<String> {
        self.remote_op("push", &push_args(options), observer)
            .map_err(|e| self.explain_rejection(e))
    }

    fn explain_rejection(&self, e: GitErrorPayload) -> GitErrorPayload {
        // "(fetch first)" means the remote tip is not even here: unknown work.
        if e.code != GitErrorCode::NonFastForward
            || !e.raw_stderr.contains("(non-fast-forward)")
            || !self.history_rewritten()
        {
            return e;
        }
        GitErrorPayload {
            code: GitErrorCode::HistoryRewritten,
            message: error::friendly_message(GitErrorCode::HistoryRewritten, &[], None),
            ..e
        }
    }

    /// The upstream has commits HEAD lacks, and every one of them has a
    /// patch-equivalent commit on HEAD (`--cherry-pick`): the divergence is our
    /// own commits, rewritten. A stale `@{upstream}` can only make this say yes
    /// wrongly when the remote moved since — and `--force-with-lease` then
    /// refuses, so the force-push it leads to stays safe.
    fn history_rewritten(&self) -> bool {
        let count = |extra: &[&str]| {
            let mut args = vec!["rev-list", "--count", "--right-only"];
            args.extend_from_slice(extra);
            args.push("HEAD...@{upstream}");
            self.read_value(&args).and_then(|n| n.parse::<u32>().ok())
        };
        matches!(
            (count(&[]), count(&["--cherry-pick"])),
            (Some(behind), Some(0)) if behind > 0
        )
    }

    /// Push the current branch to `remote` (default `origin`) and make it
    /// the branch's upstream.
    pub fn publish_branch(
        &self,
        remote: Option<&str>,
        observer: Option<&dyn OpObserver>,
    ) -> Result<String> {
        let remote = remote.unwrap_or("origin");
        self.remote_op(
            "push",
            &["push", "--progress", "-u", remote, "HEAD"],
            observer,
        )
    }

    /// Rebase the current branch onto `base`. Conflicts pause the rebase and
    /// fail as `rebase-conflicts`; continuing or aborting is
    /// [`control`](Self::control)'s.
    pub fn rebase(&self, base: &str, observer: Option<&dyn OpObserver>) -> Result<String> {
        self.remote_op("rebase", &["rebase", base], observer)
    }

    /// Each remote once, with its fetch URL.
    pub fn remotes(&self) -> Result<Vec<RemoteInfo>> {
        let out = self.out(&["remote", "-v"])?;
        let mut seen = std::collections::HashSet::new();
        let mut remotes = Vec::new();
        for line in out.lines() {
            // "origin\turl (fetch)"
            let mut it = line.split_whitespace();
            let (Some(name), Some(url)) = (it.next(), it.next()) else {
                continue;
            };
            if seen.insert(name.to_string()) {
                remotes.push(RemoteInfo {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
        Ok(remotes)
    }

    pub fn add_remote(&self, name: &str, url: &str) -> Result<()> {
        self.mutate(&["remote", "add", name, url])?;
        Ok(())
    }

    pub fn remove_remote(&self, name: &str) -> Result<()> {
        self.mutate(&["remote", "remove", name])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_args_map_each_option_to_its_flag() {
        let plain = PushOptions::default();
        assert_eq!(push_args(plain), ["push", "--progress"]);
        assert_eq!(
            push_args(PushOptions {
                force_with_lease: true,
                ..plain
            }),
            [
                "push",
                "--progress",
                "--force-with-lease",
                "--force-if-includes"
            ]
        );
        assert_eq!(
            push_args(PushOptions {
                follow_tags: true,
                ..plain
            }),
            ["push", "--progress", "--follow-tags"]
        );
        assert_eq!(
            push_args(PushOptions {
                force_with_lease: true,
                follow_tags: true,
                remote: Some("upstream"),
            }),
            [
                "push",
                "--progress",
                "--force-with-lease",
                "--force-if-includes",
                "--follow-tags",
                "upstream"
            ]
        );
    }

    #[test]
    fn pull_args_map_each_strategy_to_its_flag() {
        assert_eq!(
            pull_args(PullStrategy::Default, None),
            ["pull", "--progress"]
        );
        assert_eq!(
            pull_args(PullStrategy::Rebase, None),
            ["pull", "--progress", "--rebase"]
        );
        assert_eq!(
            pull_args(PullStrategy::Merge, Some("upstream")),
            ["pull", "--progress", "--no-rebase", "upstream"]
        );
    }

    #[test]
    fn pull_preference_follows_gits_precedence() {
        use PullPreference::{Ask, Merge, Rebase};
        // (branch.<name>.rebase, pull.rebase, pull.ff) → what a plain pull does.
        type Case<'a> = (
            Option<&'a str>,
            Option<&'a str>,
            Option<&'a str>,
            PullPreference,
        );
        let cases: &[Case] = &[
            (None, None, None, Ask),
            (None, Some("true"), None, Rebase),
            (None, Some("merges"), None, Rebase),
            (None, Some("interactive"), None, Rebase),
            (None, Some("false"), None, Merge),
            (None, Some("no"), None, Merge),
            (Some("true"), Some("false"), None, Rebase),
            (Some("false"), Some("true"), None, Merge),
            (None, None, Some("true"), Merge),
            (None, None, Some("false"), Merge),
            (None, None, Some("only"), Ask),
            (None, Some("true"), Some("only"), Ask),
            (Some("true"), None, Some("only"), Ask),
        ];
        for &(branch, pull, ff, want) in cases {
            assert_eq!(
                resolve_pull_preference(branch, pull, ff),
                want,
                "branch.rebase={branch:?} pull.rebase={pull:?} pull.ff={ff:?}"
            );
        }
    }
}
