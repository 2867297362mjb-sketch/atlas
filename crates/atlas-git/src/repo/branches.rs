//! Branches: listing, switching, renaming, deleting, merging and the merge
//! preview.

use serde::Serialize;

use super::{branch_arg, Repository, Result, US};
use crate::error::{self, GitErrorCode, GitErrorPayload};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    /// True for `refs/remotes/*` entries (e.g. `origin/main`). Local checkout
    /// of one should use the short name so git creates a tracking branch.
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub subject: String,
    pub date: String,
}

/// What merging a branch into the current one would do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergePreviewKind {
    /// Merges with no conflicts.
    Clean,
    /// Would produce `conflicted_files` conflicts.
    Conflicts,
    /// Nothing to merge (0 commits).
    Uptodate,
    /// Unrelated histories (no merge base).
    Invalid,
    /// git too old for a `merge-tree --write-tree` preview; the merge can
    /// still be attempted, its conflicts just cannot be predicted.
    Unsupported,
}

/// Dry-run preview of merging a branch into the current one: what is shown
/// under the branch picker before the user confirms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub kind: MergePreviewKind,
    /// Commits on the branch not yet on the current one (what merging brings in).
    pub commit_count: u32,
    /// Files that would conflict (only meaningful for `Conflicts`).
    pub conflicted_files: u32,
}

impl MergePreview {
    fn of(kind: MergePreviewKind, commit_count: u32, conflicted_files: u32) -> Self {
        MergePreview {
            kind,
            commit_count,
            conflicted_files,
        }
    }
}

/// Parse git's `%(upstream:track)` ("[ahead 2, behind 1]" / "[gone]") into
/// (ahead, behind).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

impl Repository<'_> {
    /// Local heads and remote-tracking branches, newest commit first, so a
    /// switcher can search and check out e.g. `origin/feature-x`.
    pub fn branches(&self) -> Result<Vec<BranchInfo>> {
        let fmt = format!(
            "%(refname:short){US}%(HEAD){US}%(upstream:short){US}%(upstream:track){US}%(contents:subject){US}%(committerdate:relative){US}%(refname)"
        );
        let out = self.out(&[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={fmt}"),
            "refs/heads",
            "refs/remotes",
        ])?;
        Ok(out
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|line| {
                let p: Vec<&str> = line.split(US).collect();
                let name = p.first().copied().unwrap_or("").to_string();
                let full_ref = p.get(6).copied().unwrap_or("");
                // Drop the symbolic `refs/remotes/origin/HEAD` pointer (its short
                // name collapses to just `origin`, so filter on the full ref).
                if name.is_empty() || full_ref.ends_with("/HEAD") {
                    return None;
                }
                let (ahead, behind) = parse_track(p.get(3).copied().unwrap_or(""));
                let upstream = p.get(2).copied().unwrap_or("");
                Some(BranchInfo {
                    name,
                    is_current: p.get(1).is_some_and(|h| h.trim() == "*"),
                    is_remote: full_ref.starts_with("refs/remotes/"),
                    upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                    ahead,
                    behind,
                    subject: p.get(4).copied().unwrap_or("").to_string(),
                    date: p.get(5).copied().unwrap_or("").to_string(),
                })
            })
            .collect())
    }

    /// `git checkout <branch> --`: the trailing `--` pins `branch` as a
    /// revision, so a name that is also a file is never read as a path to
    /// restore. The watcher sees the files move; nobody else is told.
    pub fn checkout(&self, branch: &str) -> Result<()> {
        self.out(&["checkout", branch_arg(branch)?, "--"])?;
        Ok(())
    }

    /// Switch to `branch` only if the working tree is clean (untracked files
    /// count): the check and the switch run back to back, so nothing a
    /// caller read earlier can have gone stale in between. A dirty tree is
    /// refused with `uncommitted-changes` and left alone. For starting a
    /// session on another session's branch, where the checkout may be shared
    /// with an agent Atlas does not run.
    pub fn switch_if_clean(&self, branch: &str) -> Result<()> {
        let branch = branch_arg(branch)?;
        let status = self
            .git(&["status", "--porcelain", "--untracked-files=normal"])
            .read_only()
            .run()?;
        if !status.stdout.trim().is_empty() {
            let code = GitErrorCode::UncommittedChanges;
            return Err(GitErrorPayload {
                code,
                message: error::friendly_message(code, &[], None),
                raw_stderr: String::new(),
                command: "git status --porcelain".into(),
                exit_code: None,
                files: Vec::new(),
                hint: None,
            });
        }
        self.checkout(branch)
    }

    /// Create `name` at HEAD and switch to it.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        self.out(&["checkout", "-b", branch_arg(name)?])?;
        Ok(())
    }

    pub fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<()> {
        self.mutate(&["branch", "-m", old_name, new_name])?;
        Ok(())
    }

    /// Delete a branch. Without `force` git refuses one that is not fully
    /// merged; it always refuses the branch that is checked out.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        let flag = if force { "-D" } else { "-d" };
        self.mutate(&["branch", flag, name])?;
        Ok(())
    }

    /// Merge `branch` into the current branch with git's own message. A
    /// merge that stops on conflicts is a `merge-conflicts` failure and
    /// leaves the merge in progress.
    pub fn merge(&self, branch: &str) -> Result<String> {
        self.mutate(&["merge", "--no-edit", branch])
    }

    /// What [`merge`](Self::merge) would do, without touching anything.
    pub fn merge_preview(&self, branch: &str) -> Result<MergePreview> {
        use MergePreviewKind::{Clean, Conflicts, Invalid, Unsupported, Uptodate};

        let head = self.out(&["rev-parse", "HEAD"])?.trim().to_string();
        let theirs = self
            .out(&["rev-parse", "--verify", &format!("{branch}^{{commit}}")])
            .map_err(|_| GitErrorPayload::internal(format!("branch '{branch}' not found")))?
            .trim()
            .to_string();

        // Unrelated histories → no common ancestor → merge would refuse.
        // `merge-base` exits 1 on no ancestor — an accepted outcome, not an error.
        let base = self
            .git(&["merge-base", &head, &theirs])
            .read_only()
            .success_codes(&[0, 1])
            .run()?;
        if base.exit_code != 0 {
            return Ok(MergePreview::of(Invalid, 0, 0));
        }

        // Commits that merging would bring in: on `branch` but not on HEAD.
        let commit_count = self
            .out(&["rev-list", "--count", &format!("{head}..{theirs}")])?
            .trim()
            .parse::<u32>()
            .unwrap_or(0);
        if commit_count == 0 {
            return Ok(MergePreview::of(Uptodate, 0, 0));
        }

        // Conflict detection via `git merge-tree --write-tree` (git 2.38+, with
        // `--name-only` in 2.40+). Exit 1 = conflicts; usage errors (unsupported
        // flags on an older git) surface as other non-zero codes.
        let mt = self
            .git(&[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--no-messages",
                "-z",
                &head,
                &theirs,
            ])
            .read_only()
            .success_codes(&[0, 1, 2, 128, 129])
            .run()?;
        if mt.exit_code == 0 {
            return Ok(MergePreview::of(Clean, commit_count, 0));
        }

        // Non-zero: conflicts (exit 1) OR the flags are unsupported on an older git
        // (usage error / exit 129). Degrade gracefully so the merge stays available.
        let stderr = &mt.stderr;
        if stderr.contains("usage:")
            || stderr.contains("unknown option")
            || stderr.contains("not a valid option")
        {
            return Ok(MergePreview::of(Unsupported, commit_count, 0));
        }

        // Conflict output (`-z`, `--name-only`): `<tree-oid>\0` then each conflicted
        // path `\0`-separated. Drop empties (section separators); first field is the
        // oid, the rest are the conflicted files.
        let mut fields = mt.stdout.split('\0').filter(|s| !s.is_empty());
        let _oid = fields.next();
        Ok(MergePreview::of(
            Conflicts,
            commit_count,
            fields.count() as u32,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_track;

    #[test]
    fn track_reads_ahead_and_behind_and_treats_gone_as_zero() {
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1));
        assert_eq!(parse_track("[ahead 3]"), (3, 0));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track("[gone]"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }
}
