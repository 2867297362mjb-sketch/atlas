//! The palette's "Add project" sources: browse to a folder on disk, start a
//! new project from a name, or clone one from a Git URL or a GitHub
//! `owner/repo`.
//!
//! New and cloned projects go in one place, `~/.atlas/projects`
//! (`projects_root`), so a name is all the palette has to ask for. Adding the
//! result as a project is the frontend's (`useProjectStore.addProject`), the
//! same as a folder picked in the native dialog.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use atlas_gh::{GhCommand, GhError, Intent};
use serde::Serialize;

/// The sign-in probe: a background read nobody should wait long for.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
/// `gh repo create`: one write to the API.
const CREATE_TIMEOUT: Duration = Duration::from_secs(30);
/// `gh repo clone`: bounded, so a remote that never answers cannot hold the
/// palette open forever.
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Where new and cloned projects go: `~/.atlas/projects`.
fn projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home directory")?;
    Ok(atlas_profile::dir_in(home).join("projects"))
}

/// `~` and `~/…` against the home directory; anything else as given.
fn expand_home(path: &str) -> Result<PathBuf, String> {
    let home = || dirs::home_dir().ok_or_else(|| "no home directory".to_string());
    if path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(home()?.join(rest));
    }
    Ok(PathBuf::from(path))
}

/// A folder name a user typed, held to one safe path segment.
fn safe_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && !name.starts_with('-');
    if ok {
        Ok(name)
    } else {
        Err(format!("\"{name}\" is not a usable folder name"))
    }
}

/// Whether the GitHub CLI can publish and clone for the user.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GhStatus {
    /// `gh` is not on the PATH.
    Missing,
    /// `gh` runs, but no account is signed in.
    SignedOut,
    Ready,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsRootInfo {
    /// Where new and cloned projects go.
    pub path: String,
    pub gh: GhStatus,
    /// The GitHub account `gh` is signed in to, when it is.
    pub github_login: Option<String>,
    /// The package manager that can install `gh` here (`brew`, `winget`),
    /// when there is one.
    pub installer: Option<&'static str>,
}

/// Asked through `atlas_gh`: with a timeout, never a prompt, and "not
/// installed" and "signed out" told apart from a failed request.
async fn gh_status() -> (GhStatus, Option<String>) {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let login = GhCommand::new(
        home,
        ["api", "user", "--jq", ".login"],
        Intent::BackgroundRead,
    )
    .timeout(STATUS_TIMEOUT)
    .run()
    .await;
    match login {
        Err(GhError::NotInstalled) => (GhStatus::Missing, None),
        Err(GhError::NotAuthenticated) => (GhStatus::SignedOut, None),
        Ok(login) => {
            let login = login.trim().to_string();
            if login.is_empty() {
                (GhStatus::SignedOut, None)
            } else {
                (GhStatus::Ready, Some(login))
            }
        }
        // Installed, and not refused for auth: a network blip or a paused
        // API should not send the user to a setup step they have already
        // done.
        Err(_) => (GhStatus::Ready, None),
    }
}

fn installer() -> Option<&'static str> {
    let runs = |program: &str, arg: &str| {
        atlas_process::command(program)
            .arg(arg)
            .output()
            .is_ok_and(|out| out.status.success())
    };
    if cfg!(target_os = "macos") || cfg!(target_os = "linux") {
        runs("brew", "--version").then_some("brew")
    } else if cfg!(windows) {
        runs("winget", "--version").then_some("winget")
    } else {
        None
    }
}

/// Where new projects go, and whether the GitHub CLI is there to publish or
/// clone one (and how to install it when it is not).
#[tauri::command]
pub async fn project_sources_info() -> Result<ProjectsRootInfo, String> {
    let path = projects_root()?.to_string_lossy().into_owned();
    let ((gh, github_login), installer) =
        tokio::join!(gh_status(), tokio::task::spawn_blocking(installer));
    let installer = installer.map_err(|e| e.to_string())?;
    Ok(ProjectsRootInfo {
        path,
        gh,
        github_login,
        installer: if gh == GhStatus::Missing {
            installer
        } else {
            None
        },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseListing {
    /// The folder listed, absolute.
    pub path: String,
    /// Its parent, absent at the filesystem root.
    pub parent: Option<String>,
    /// The folders in it, by name, sorted, dot-folders last.
    pub directories: Vec<String>,
}

/// The folders in `path` (`~` expanded), for the palette's folder browser.
#[tauri::command]
pub async fn project_browse(path: String) -> Result<BrowseListing, String> {
    // `components()` drops a trailing separator (`~/` and a typed `/a/b/`
    // both keep one), so the path the palette adds matches the same folder
    // added without it.
    let dir: PathBuf = expand_home(&path)?.components().collect();
    tokio::task::spawn_blocking(move || {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut directories: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        directories.sort_by(|a, b| {
            (a.starts_with('.'), a.to_lowercase()).cmp(&(b.starts_with('.'), b.to_lowercase()))
        });
        Ok(BrowseListing {
            path: dir.to_string_lossy().into_owned(),
            parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
            directories,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn git(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = atlas_git::GitCommand::new(dir, args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.success() {
        Ok(())
    } else {
        Err(out.stderr_text().trim().to_string())
    }
}

/// A project `project_create` made. `warning` is set when the folder and its
/// repository stand but publishing to GitHub failed: the project is still
/// added, and the warning shown.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub path: String,
    pub warning: Option<String>,
}

/// Start a new project called `name` in `~/.atlas/projects`: the folder, an
/// empty Git repository in it, and — with `github_private` — a private
/// GitHub repository of the same name as its `origin`.
#[tauri::command]
pub async fn project_create(name: String, github_private: bool) -> Result<CreatedProject, String> {
    let name = safe_name(&name)?.to_string();
    let dir = projects_root()?.join(&name);
    let made = dir.clone();
    tokio::task::spawn_blocking(move || {
        let dir = made;
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // `create_dir`, not `create_dir_all`: it fails when the folder is
        // already there, with no window between a check and the create.
        std::fs::create_dir(&dir).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{} already exists", dir.display()),
            _ => e.to_string(),
        })?;
        if let Err(e) = git(&dir, &["init", "--quiet"]) {
            // Nothing was made but the empty folder; leave no trace, so the
            // same name can be tried again.
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    let path = dir.to_string_lossy().into_owned();
    let warning = if github_private {
        // The folder and its repository stand; only publishing can fail now.
        publish_private(&dir, &name)
            .await
            .err()
            .map(|reason| format!("The GitHub repository was not created: {reason}"))
    } else {
        None
    };
    Ok(CreatedProject { path, warning })
}

/// `gh repo create` for the repository in `dir`, as its `origin`. A write
/// the user asked for, so it runs even while the API is paused.
async fn publish_private(dir: &Path, name: &str) -> Result<(), String> {
    let args = [
        "repo",
        "create",
        name,
        "--private",
        "--source",
        ".",
        "--remote",
        "origin",
    ];
    let output = GhCommand::new(dir, args, Intent::Write)
        .timeout(CREATE_TIMEOUT)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.success() {
        Ok(())
    } else {
        Err(output.stderr.trim().to_string())
    }
}

/// The folder name a clone URL implies: its last segment, less `.git`.
fn repo_name_from_url(url: &str) -> Option<&str> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    safe_name(name).ok()
}

/// A GitHub `owner/repo` (or a github.com URL) as an HTTPS clone URL.
fn github_clone_url(spec: &str) -> Option<String> {
    let spec = spec.trim().trim_end_matches('/').trim_end_matches(".git");
    let spec = spec
        .strip_prefix("https://github.com/")
        .or_else(|| spec.strip_prefix("github.com/"))
        .unwrap_or(spec);
    let (owner, repo) = spec.split_once('/')?;
    let segment = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (segment(owner) && segment(repo) && !repo.contains('/'))
        .then(|| format!("https://github.com/{owner}/{repo}.git"))
}

/// Clone `url` (any Git URL, or a GitHub `owner/repo` with `github`) into
/// `~/.atlas/projects/<repo>`. Answers the folder. A GitHub clone goes
/// through `gh repo clone`, so a private repository clones with the
/// credentials `gh` already holds.
#[tauri::command]
pub async fn project_clone(url: String, github: bool) -> Result<String, String> {
    let url = if github {
        github_clone_url(&url).ok_or("Enter a GitHub repository as owner/repo")?
    } else {
        url.trim().to_string()
    };
    if url.starts_with('-') {
        return Err("That is not a Git URL".to_string());
    }
    let name = repo_name_from_url(&url)
        .ok_or("Could not tell the repository's name from that URL")?
        .to_string();
    let root = projects_root()?;
    let dest = root.join(&name);
    let (made_root, made_dest) = (root.clone(), dest.clone());
    tokio::task::spawn_blocking(move || {
        if made_dest.exists() {
            return Err(format!("{} already exists", made_dest.display()));
        }
        std::fs::create_dir_all(&made_root).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    if github {
        // Minutes of `git`, not an API request: it holds no API permit.
        let output = GhCommand::new(
            &root,
            [
                OsStr::new("repo"),
                OsStr::new("clone"),
                OsStr::new(&url),
                dest.as_os_str(),
            ],
            Intent::LongWrite,
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .timeout(CLONE_TIMEOUT)
        .output()
        .await
        .map_err(|e| format!("clone: {e}"))?;
        if !output.success() {
            return Err(output.stderr.trim().to_string());
        }
        return Ok(dest.to_string_lossy().into_owned());
    }
    tokio::task::spawn_blocking(move || {
        let out = atlas_git::GitCommand::without_repo(&["clone", "--"])
            .arg(&url)
            .arg(&dest)
            .output()
            .map_err(|e| format!("clone: {e}"))?;
        if !out.success() {
            return Err(out.stderr_text().trim().to_string());
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_clone_urls() {
        assert_eq!(repo_name_from_url("https://github.com/a/b.git"), Some("b"));
        assert_eq!(repo_name_from_url("git@github.com:a/b.git"), Some("b"));
        assert_eq!(repo_name_from_url("ssh://host/x/y/"), Some("y"));
        assert_eq!(repo_name_from_url(".."), None);
    }

    #[test]
    fn github_specs() {
        assert_eq!(
            github_clone_url("tryatlas/atlas").as_deref(),
            Some("https://github.com/tryatlas/atlas.git")
        );
        assert_eq!(
            github_clone_url("https://github.com/a/b/").as_deref(),
            Some("https://github.com/a/b.git")
        );
        assert_eq!(github_clone_url("a/b/c"), None);
        assert_eq!(github_clone_url("a b/c"), None);
    }

    #[test]
    fn unsafe_names_are_refused() {
        assert!(safe_name("../x").is_err());
        assert!(safe_name("-rf").is_err());
        assert!(safe_name("my-app").is_ok());
    }
}
