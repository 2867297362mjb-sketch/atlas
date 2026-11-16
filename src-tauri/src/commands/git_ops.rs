//! The Source-Control manager's git commands: the Tauri side of
//! [`atlas_git::Repository`].
//!
//! What each operation does, and every rule it enforces, lives in
//! `atlas-git` (`repo/`), where it is tested against real repositories
//! without compiling the app. A command here is an adapter: move to a
//! blocking thread, build the repository with a notifier that emits
//! `atlas:git-changed` through the watcher helper, call the crate, and hand
//! back its typed [`GitErrorPayload`]. Long operations also get an
//! [`OpEmitter`], which turns the crate's [`OpObserver`] calls into
//! `atlas:git:op` events.
//!
//! The command names, argument names and result shapes are the frontend's
//! contract: change none of them here.

// `|repo| repo.tags()` cannot be the path `Repository::tags`: a method path
// names one lifetime of `Repository<'_>`, and the helpers below need a
// function over every one.
#![allow(clippy::redundant_closure_for_method_calls)]

pub use atlas_git::repo::{
    BranchInfo, CommitDetail, InProgress, MergePreview, PullPreference, PullStrategy, RemoteInfo,
    StashEntry,
};
use atlas_git::repo::{CommitRequest, InProgressKind, OpAction, PushOptions, ResetMode};
use atlas_git::{GitErrorPayload, OpObserver, Repository};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::git_autofetch::{GitAutoFetchState, AUTOFETCH_EVENT};
use crate::commands::git_watcher::emit_synthetic_change;

type GitResult<T> = Result<T, GitErrorPayload>;

/// spawn_blocking join failure → internal payload (never a raw string).
fn join_err(e: tokio::task::JoinError) -> GitErrorPayload {
    GitErrorPayload::internal(e.to_string())
}

/// Run `op` against the repository at `path` on a blocking thread. For a
/// read: nobody is told anything.
async fn read<T: Send + 'static>(
    path: String,
    op: impl FnOnce(&Repository<'_>) -> GitResult<T> + Send + 'static,
) -> GitResult<T> {
    tokio::task::spawn_blocking(move || op(&Repository::new(&path, &())))
        .await
        .map_err(join_err)?
}

/// [`read`] for an operation that can change the repository: the crate's
/// notifier emits `atlas:git-changed` so listeners refresh.
async fn change<T: Send + 'static>(
    app: AppHandle,
    path: String,
    op: impl FnOnce(&Repository<'_>) -> GitResult<T> + Send + 'static,
) -> GitResult<T> {
    tokio::task::spawn_blocking(move || {
        let notify = |repo: &Path| emit_synthetic_change(&app, repo);
        op(&Repository::new(&path, &notify))
    })
    .await
    .map_err(join_err)?
}

/// [`change`] for an operation that talks to a remote, or runs as long as
/// one. Background auto-fetch stays off this repository until it is done,
/// and a successful fetch or pull restarts its timer (see `git_autofetch`).
/// With an `op_id` the operation streams as `atlas:git:op` events; without
/// one it runs buffered, which keeps older call sites working.
async fn remote_op(
    app: AppHandle,
    path: String,
    kind: &'static str,
    op_id: Option<String>,
    op: impl FnOnce(&Repository<'_>, Option<&dyn OpObserver>) -> GitResult<String> + Send + 'static,
) -> GitResult<String> {
    tokio::task::spawn_blocking(move || {
        let autofetch = app.state::<GitAutoFetchState>();
        let _busy = autofetch.hold(Path::new(&path));
        let notify = |repo: &Path| emit_synthetic_change(&app, repo);
        let emitter = op_id.map(|id| OpEmitter::new(app.clone(), id, path.clone(), kind));
        let result = op(
            &Repository::new(&path, &notify),
            emitter.as_ref().map(|e| e as &dyn OpObserver),
        );
        if result.is_ok() && matches!(kind, "fetch" | "pull") {
            let status = autofetch.record_success(Path::new(&path), std::time::SystemTime::now());
            let _ = app.emit(AUTOFETCH_EVENT, status);
        }
        result
    })
    .await
    .map_err(join_err)?
}

// ── Branches ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_branches_full(path: String) -> Result<Vec<BranchInfo>, GitErrorPayload> {
    read(path, |repo| repo.branches()).await
}

#[tauri::command]
pub async fn git_rename_branch(
    path: String,
    old_name: String,
    new_name: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| {
        repo.rename_branch(&old_name, &new_name)
    })
    .await
}

#[tauri::command]
pub async fn git_branch_delete(
    path: String,
    name: String,
    force: bool,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.delete_branch(&name, force)).await
}

#[tauri::command]
pub async fn git_merge_branch(
    path: String,
    branch: String,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    change(app, path, move |repo| repo.merge(&branch)).await
}

/// Dry-run preview of merging `branch` into the current branch. Read-only,
/// so it takes no `AppHandle` and emits no change event.
#[tauri::command]
pub async fn git_merge_preview(
    path: String,
    branch: String,
) -> Result<MergePreview, GitErrorPayload> {
    read(path, move |repo| repo.merge_preview(&branch)).await
}

// ── Remote sync ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_fetch(
    path: String,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    remote_op(app, path, "fetch", op_id, |repo, observer| {
        repo.fetch(observer)
    })
    .await
}

/// Read before pulling a diverged branch, so Atlas only asks "rebase or
/// merge?" when git itself would refuse — never over a saved preference.
#[tauri::command]
pub async fn git_pull_preference(path: String) -> Result<PullPreference, GitErrorPayload> {
    read(path, |repo| Ok(repo.pull_preference())).await
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    strategy: Option<PullStrategy>,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    remote_op(app, path, "pull", op_id, move |repo, observer| {
        repo.pull(strategy.unwrap_or_default(), remote.as_deref(), observer)
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    path: String,
    force_with_lease: bool,
    follow_tags: bool,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    remote_op(app, path, "push", op_id, move |repo, observer| {
        repo.push(
            PushOptions {
                force_with_lease,
                follow_tags,
                remote: remote.as_deref(),
            },
            observer,
        )
    })
    .await
}

/// Push the current branch to a remote (default `origin`) and set upstream.
#[tauri::command]
pub async fn git_publish_branch(
    path: String,
    remote: Option<String>,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    remote_op(app, path, "push", op_id, move |repo, observer| {
        repo.publish_branch(remote.as_deref(), observer)
    })
    .await
}

/// Rebase the current branch onto `base`, streaming output (`Rebasing
/// (n/m)` lines land in the live strip). Conflicts pause the rebase — the
/// in-progress banner + conflicts view take over, and continue/abort go
/// through `git_op_control` as usual.
#[tauri::command]
pub async fn git_rebase(
    path: String,
    base: String,
    op_id: Option<String>,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    remote_op(app, path, "rebase", op_id, move |repo, observer| {
        repo.rebase(&base, observer)
    })
    .await
}

/// Undo the last commit. Refused when it is already on the upstream.
#[tauri::command]
pub async fn git_undo_commit(path: String, app: AppHandle) -> Result<(), GitErrorPayload> {
    change(app, path, |repo| repo.undo_commit()).await
}

/// Squash the last `count` commits into one with this message.
#[tauri::command]
pub async fn git_squash_last(
    path: String,
    count: u32,
    summary: String,
    description: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| {
        repo.squash_last(count, &summary, description.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<RemoteInfo>, GitErrorPayload> {
    read(path, |repo| repo.remotes()).await
}

#[tauri::command]
pub async fn git_remote_add(
    path: String,
    name: String,
    url: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.add_remote(&name, &url)).await
}

#[tauri::command]
pub async fn git_remote_remove(
    path: String,
    name: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.remove_remote(&name)).await
}

// ── Stash ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<StashEntry>, GitErrorPayload> {
    read(path, |repo| repo.stashes()).await
}

#[tauri::command]
pub async fn git_stash_push(
    path: String,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.stash_push(message.as_deref())).await
}

#[tauri::command]
pub async fn git_stash_apply(
    path: String,
    index: u32,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.stash_apply(index)).await
}

#[tauri::command]
pub async fn git_stash_pop(
    path: String,
    index: u32,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.stash_pop(index)).await
}

#[tauri::command]
pub async fn git_stash_drop(
    path: String,
    index: u32,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.stash_drop(index)).await
}

// ── Working tree / history ops ───────────────────────────────────────────

/// Discard tracked changes (staged + worktree) for `files`, back to HEAD.
#[tauri::command]
pub async fn git_discard(
    path: String,
    files: Vec<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.discard(&files)).await
}

/// "Revert" ADDED files (new / untracked) by removing them. Used by the
/// Source Control revert button for added files.
#[tauri::command]
pub async fn git_delete_added(
    path: String,
    files: Vec<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.delete_added(&files)).await
}

#[tauri::command]
pub async fn git_reset(
    path: String,
    target: String,
    mode: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| {
        repo.reset(&target, ResetMode::parse(&mode))
    })
    .await
}

#[tauri::command]
pub async fn git_revert(
    path: String,
    sha: String,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    change(app, path, move |repo| repo.revert(&sha)).await
}

#[tauri::command]
pub async fn git_cherry_pick(
    path: String,
    sha: String,
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    change(app, path, move |repo| repo.cherry_pick(&sha)).await
}

// ── Tags ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<String>, GitErrorPayload> {
    read(path, |repo| repo.tags()).await
}

#[tauri::command]
pub async fn git_create_tag(
    path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| {
        repo.create_tag(&name, target.as_deref(), message.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn git_delete_tag(
    path: String,
    name: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    change(app, path, move |repo| repo.delete_tag(&name)).await
}

// ── Commit detail (history view) ─────────────────────────────────────────

/// `ignore_whitespace` is `diffIgnoreWhitespace`. A commit is only ever
/// read here.
#[tauri::command]
pub async fn git_show(
    path: String,
    sha: String,
    ignore_whitespace: Option<bool>,
) -> Result<CommitDetail, GitErrorPayload> {
    read(path, move |repo| {
        repo.show(&sha, ignore_whitespace.unwrap_or(false))
    })
    .await
}

// ── In-progress operation detection (conflict banner) ────────────────────

#[tauri::command]
pub async fn git_inprogress(path: String) -> Result<InProgress, GitErrorPayload> {
    read(path, |repo| repo.in_progress()).await
}

// ── Streaming operations (`atlas:git:op`) ────────────────────────────────
//
// Long-running git commands (commit, push, pull, fetch — and the hooks they
// run) stream their output live so the UI can show a busy state with real
// feedback instead of appearing hung. One event name, discriminated by
// `phase`:
//   started → (output | progress)* → done{ok, error?}
//
// Output is BATCHED. Every Tauri event is a `webview.eval` that runs on the
// macOS main thread, and the webview then parses and runs a handler for it;
// one event per line turned a pre-push hook's test run or a big pull's
// per-file stat (thousands of lines) into thousands of main-thread hops and
// store updates back to back, which froze the whole app. Lines collect here
// and a flusher thread sends them every `OP_FLUSH_INTERVAL` as one `output`
// event carrying `lines`, followed by the latest `progress` — the bar only
// ever shows the newest one, so intermediate ones are dropped.

/// How often buffered output goes to the frontend: ~12 events a second at
/// most, whatever the child prints.
const OP_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(80);

/// Lines kept per batch; older ones in the same batch are dropped. The output
/// strip keeps 500 (`OP_LINES_CAP` in git-store.ts), so a batch past that
/// could never be shown in full anyway, and this bounds the event's size when
/// a hook floods.
const OP_BATCH_MAX_LINES: usize = 500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitOpEventPayload<'a> {
    op_id: &'a str,
    repo: &'a str,
    kind: &'a str,
    phase: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    lines: Option<&'a [OpLine]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a GitErrorPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

/// One line of child output in an `output` batch.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct OpLine {
    stream: &'static str,
    line: String,
}

/// What has arrived since the last flush.
#[derive(Debug, Default)]
struct OpBatch {
    lines: std::collections::VecDeque<OpLine>,
    /// Latest progress, as a percent and its step title.
    progress: Option<(f32, String)>,
}

impl OpBatch {
    fn push_line(&mut self, stream: &'static str, line: &str) {
        if self.lines.len() == OP_BATCH_MAX_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(OpLine {
            stream,
            line: line.to_string(),
        });
    }

    fn take(&mut self) -> (Vec<OpLine>, Option<(f32, String)>) {
        (self.lines.drain(..).collect(), self.progress.take())
    }
}

struct OpEmitterInner {
    app: AppHandle,
    op_id: String,
    repo: String,
    kind: &'static str,
    batch: std::sync::Mutex<OpBatch>,
}

impl OpEmitterInner {
    fn emit(&self, phase: &str, fields: GitOpFields<'_>) {
        let _ = self.app.emit(
            "atlas:git:op",
            GitOpEventPayload {
                op_id: &self.op_id,
                repo: &self.repo,
                kind: self.kind,
                phase,
                lines: fields.lines,
                ok: fields.ok,
                error: fields.error,
                percent: fields.percent,
                title: fields.title,
            },
        );
    }

    /// Send what has collected: the lines as one event, then the newest
    /// progress. Only the flusher thread and `done` (after stopping the
    /// flusher) call this, so batches can never overtake each other.
    fn flush(&self) {
        let (lines, progress) = match self.batch.lock() {
            Ok(mut batch) => batch.take(),
            Err(_) => return,
        };
        if !lines.is_empty() {
            self.emit(
                "output",
                GitOpFields {
                    lines: Some(&lines),
                    ..GitOpFields::default()
                },
            );
        }
        if let Some((percent, title)) = progress {
            self.emit(
                "progress",
                GitOpFields {
                    percent: Some(percent),
                    title: Some(&title),
                    ..GitOpFields::default()
                },
            );
        }
    }
}

#[derive(Default)]
struct GitOpFields<'a> {
    lines: Option<&'a [OpLine]>,
    ok: Option<bool>,
    error: Option<&'a GitErrorPayload>,
    percent: Option<f32>,
    title: Option<&'a str>,
}

/// Emits `atlas:git:op` events for one operation: the [`OpObserver`] handed
/// to `atlas-git`. Output is buffered and flushed on a timer from `started`
/// until `finished` (see the section note above).
struct OpEmitter {
    inner: std::sync::Arc<OpEmitterInner>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    flusher: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
    /// `started` was sent and `done` not yet: see `Drop`.
    open: std::sync::atomic::AtomicBool,
}

impl OpEmitter {
    fn new(app: AppHandle, op_id: String, repo: String, kind: &'static str) -> Self {
        OpEmitter {
            inner: std::sync::Arc::new(OpEmitterInner {
                app,
                op_id,
                repo,
                kind,
                batch: std::sync::Mutex::new(OpBatch::default()),
            }),
            stop: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            flusher: std::sync::Mutex::new(None),
            open: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Stop the flusher (waking it rather than waiting out its sleep) and
    /// join it, so nothing it sends can land after what follows.
    fn stop_flusher(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        let handle = self.flusher.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            handle.thread().unpark();
            let _ = handle.join();
        }
    }

    /// The one end of an operation: stop the flusher, send what is left, then
    /// `done`.
    fn finish(&self, error: Option<&GitErrorPayload>) {
        self.open.store(false, std::sync::atomic::Ordering::Release);
        self.stop_flusher();
        // Whatever arrived since the last tick goes out before `done`, so the
        // strip holds git's last words when the operation fails.
        self.inner.flush();
        self.inner.emit(
            "done",
            GitOpFields {
                ok: Some(error.is_none()),
                error,
                ..GitOpFields::default()
            },
        );
    }
}

impl OpObserver for OpEmitter {
    fn started(&self) {
        self.open.store(true, std::sync::atomic::Ordering::Release);
        self.inner.emit("started", GitOpFields::default());
        let inner = self.inner.clone();
        let stop = self.stop.clone();
        let handle = std::thread::Builder::new()
            .name("git-op-flush".into())
            .spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Acquire) {
                    std::thread::park_timeout(OP_FLUSH_INTERVAL);
                    if stop.load(std::sync::atomic::Ordering::Acquire) {
                        break;
                    }
                    inner.flush();
                }
            })
            .ok();
        if let Ok(mut slot) = self.flusher.lock() {
            *slot = handle;
        }
    }

    fn output(&self, stream: atlas_git::Stream, line: &str) {
        let name = match stream {
            atlas_git::Stream::Stdout => "stdout",
            atlas_git::Stream::Stderr => "stderr",
        };
        if let Ok(mut batch) = self.inner.batch.lock() {
            batch.push_line(name, line);
        }
    }

    fn progress(&self, fraction: f32, title: &str) {
        if let Ok(mut batch) = self.inner.batch.lock() {
            batch.progress = Some((fraction * 100.0, title.to_string()));
        }
    }

    fn finished(&self, error: Option<&GitErrorPayload>) {
        self.finish(error);
    }
}

impl Drop for OpEmitter {
    /// A path that returns without `finished` must not leave the thread running,
    /// nor the UI waiting: an `?` early return or a panic unwinding through
    /// the operation still ends it, as a failure, instead of leaving the
    /// commit button spinning until the app is restarted.
    fn drop(&mut self) {
        if self.open.load(std::sync::atomic::Ordering::Acquire) {
            let error = GitErrorPayload::internal("The git operation ended unexpectedly.");
            self.finish(Some(&error));
        } else {
            self.stop_flusher();
        }
    }
}

/// Streaming commit (v2): live hook output as `atlas:git:op` events, and
/// typed errors. `co_authors` are "Name <email>" strings.
#[tauri::command]
pub async fn git_commit_v2(
    path: String,
    summary: String,
    description: Option<String>,
    amend: bool,
    co_authors: Option<Vec<String>>,
    op_id: String,
    app: AppHandle,
) -> Result<(), GitErrorPayload> {
    let request = CommitRequest {
        summary,
        description,
        amend,
        co_authors: co_authors.unwrap_or_default(),
    };
    let emitter = OpEmitter::new(app.clone(), op_id, path.clone(), "commit");
    change(app, path, move |repo| repo.commit(request, &emitter)).await
}

/// Abort or continue an in-progress merge/rebase/cherry-pick/revert.
#[tauri::command]
pub async fn git_op_control(
    path: String,
    kind: String,
    action: String, // "abort" | "continue"
    app: AppHandle,
) -> Result<String, GitErrorPayload> {
    let Some(kind) = InProgressKind::parse(&kind) else {
        return Err(GitErrorPayload::internal(format!(
            "'{kind}' is not an operation that can be continued or aborted."
        )));
    };
    change(app, path, move |repo| {
        repo.control(kind, OpAction::parse(&action))
    })
    .await
}

/// The batching between the crate's observer calls and the events sent.
/// The operations themselves are tested in `atlas-git`
/// (`tests/repository.rs`).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_batch_keeps_lines_in_order_and_only_the_latest_progress() {
        let mut batch = OpBatch::default();
        batch.push_line("stderr", "Counting objects: 50%");
        batch.progress = Some((10.0, "Counting objects".into()));
        batch.push_line("stdout", "done");
        batch.progress = Some((30.0, "Compressing objects".into()));

        let (lines, progress) = batch.take();
        assert_eq!(
            lines,
            [
                OpLine {
                    stream: "stderr",
                    line: "Counting objects: 50%".into()
                },
                OpLine {
                    stream: "stdout",
                    line: "done".into()
                },
            ]
        );
        assert_eq!(progress, Some((30.0, "Compressing objects".into())));

        // Taking empties it: the next tick sends nothing.
        let (lines, progress) = batch.take();
        assert!(lines.is_empty() && progress.is_none());
    }

    #[test]
    fn op_batch_drops_its_oldest_lines_past_the_cap() {
        let mut batch = OpBatch::default();
        for i in 0..OP_BATCH_MAX_LINES + 25 {
            batch.push_line("stdout", &format!("line {i}"));
        }
        let (lines, _) = batch.take();
        assert_eq!(lines.len(), OP_BATCH_MAX_LINES);
        assert_eq!(lines[0].line, "line 25");
        assert_eq!(
            lines.last().unwrap().line,
            format!("line {}", OP_BATCH_MAX_LINES + 24)
        );
    }
}
