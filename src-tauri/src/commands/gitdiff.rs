//! The editor gutter's line classification, from `atlas-gitdiff`. The diff
//! viewer reads `git_review` instead.

use atlas_git::GitCommand;
use atlas_gitdiff::{line_status, LineStatus};

/// Run `git diff -U0` for one file and return the raw unified output.
/// `staged` selects the index-vs-HEAD diff; otherwise it's worktree-vs-HEAD.
/// Falls back to `--no-index` against /dev/null so brand-new / untracked
/// files read as all-added instead of an empty diff. Never `-w`: the gutter
/// marks every changed line, whitespace included.
fn run_git_diff(path: &str, file: &str, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "-U0"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(file);

    let text = git_stdout(path, &args)?;
    if !text.trim().is_empty() {
        return Ok(text);
    }

    // Empty diff. This is the COMMON case for a clean, tracked file — and it
    // genuinely means "no changes", so return empty. We must NOT fall back to
    // `--no-index` here: that would diff the file against /dev/null and report
    // EVERY line as added, which is what made the editor gutter mark all lines
    // until the first edit. Only an UNTRACKED file should render as all-added.
    if is_tracked(path, file) {
        // ...with one exception: a file that was CREATED and then staged is in
        // the index (so `is_tracked` says yes) while the worktree matches the
        // index (so the diff above is empty) — yet it is entirely new and has
        // every right to render as all-added. `git diff --cached` against HEAD
        // is the one that shows it.
        //
        // Narrowed to files absent from HEAD on purpose: for a file that DOES
        // exist in HEAD, an empty worktree diff really does mean "nothing
        // uncommitted here", and falling back to the staged diff would make the
        // editor gutter mark lines the user already staged and moved on from.
        if !staged && !exists_in_head(path, file) {
            let cached = git_stdout(path, &["diff", "--no-color", "-U0", "--cached", "--", file])?;
            if !cached.trim().is_empty() {
                return Ok(cached);
            }
        }
        return Ok(String::new());
    }

    // Untracked / brand-new file — diff against /dev/null so it shows as fully
    // added. `--no-index` exits non-zero by design, so ignore status; take stdout.
    let nul = devnull();
    git_stdout(
        path,
        &["diff", "--no-color", "-U0", "--no-index", "--", nul, file],
    )
}

/// What git printed, whatever its exit code: every diff here reads stdout
/// and treats an empty one as "no change".
fn git_stdout(path: &str, args: &[&str]) -> Result<String, String> {
    GitCommand::new(path, args)
        .output()
        .map(|out| out.stdout_text())
        .map_err(|e| e.to_string())
}

/// Whether git answered with exit 0; a git that could not run is a "no".
fn git_ok(path: &str, args: &[&str]) -> bool {
    GitCommand::new(path, args)
        .output()
        .is_ok_and(|out| out.success())
}

/// Whether `file` is tracked by git (in the index). `git ls-files
/// --error-unmatch` exits 0 only for tracked paths.
fn is_tracked(path: &str, file: &str) -> bool {
    git_ok(path, &["ls-files", "--error-unmatch", "--", file])
}

/// Whether `file` exists in the HEAD commit. Distinguishes "tracked and
/// unchanged" from "newly created and staged", which `is_tracked` cannot.
fn exists_in_head(path: &str, file: &str) -> bool {
    git_ok(path, &["cat-file", "-e", &format!("HEAD:{file}")])
}

fn devnull() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

/// New-file line classification for the editor gutter (added / changed /
/// deleted-before). Uses zero-context diff — cheap.
#[tauri::command]
pub async fn git_diff_line_status(
    path: String,
    file: String,
    staged: bool,
) -> Result<LineStatus, String> {
    tokio::task::spawn_blocking(move || Ok(line_status(&run_git_diff(&path, &file, staged)?)))
        .await
        .map_err(|e| e.to_string())?
}
