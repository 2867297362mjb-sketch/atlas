//! GitHub avatars for a repository's commit authors, read through the user's
//! GitHub CLI (`atlas_gh`): `gh` already holds the user's credentials (so
//! private repositories work) and knows which GitHub repository the
//! checkout's remote points at.
//!
//! A commit's email says nothing GitHub-shaped on its own; only GitHub knows
//! which account an email belongs to. One `gh api` call for the newest
//! hundred commits of the current branch (one page of GitHub's API) answers that for every author
//! in them, and the frontend shares the answer between every avatar in the
//! repository. A branch GitHub does not have (unpushed, detached HEAD) costs a
//! second call, for the default branch, whose authors mostly overlap.
//!
//! The result says why there is nothing, from how the `gh` run ended:
//! [`RepoAvatars::Unavailable`] stops the caller asking for the session,
//! [`RepoAvatars::Failed`] is about this repository now. Neither is an `Err`:
//! the caller falls back to Gravatar, and no avatar is worth a toast.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use atlas_gh::{Api, GhCommand, GhError, Intent};
use serde::{Deserialize, Serialize};

/// How long one `gh` read gets. Nobody is waiting on an avatar, and a
/// captive portal or a dead VPN would otherwise hold a permit for as long
/// as the TCP stack cares to wait.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Only an avatar served from here is passed on: it is the one image origin
/// the webview's CSP admits for GitHub.
const AVATAR_ORIGIN: &str = "https://avatars.githubusercontent.com/";

/// Commits whose author is a GitHub account, reduced to email → avatar inside
/// `gh` so only the pairs cross the pipe.
const JQ: &str = concat!(
    "[.[] | select(.author != null)",
    " | {email: .commit.author.email, avatar: .author.avatar_url}]"
);

/// The answer for one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoAvatars {
    /// Avatar URL per author email, the email lowercased.
    #[serde(rename_all = "camelCase")]
    Ok { by_email: BTreeMap<String, String> },
    /// `gh` is not installed or not signed in.
    Unavailable,
    /// `gh` could not answer for this repository: not a GitHub remote,
    /// offline, timed out, or output Atlas could not read.
    Failed,
}

#[derive(Debug, Deserialize)]
struct AuthorAvatar {
    email: Option<String>,
    avatar: Option<String>,
}

/// GitHub avatars for the authors of the repository at `path`.
#[tauri::command]
pub async fn git_repo_avatars(path: String) -> Result<RepoAvatars, String> {
    if path.trim().is_empty() {
        return Ok(RepoAvatars::Failed);
    }
    // A background read of the REST API: refused, not queued, while GitHub
    // has that API paused, and its own refusal pauses no GraphQL read.
    let read = |on_branch: bool| {
        GhCommand::new(&path, gh_api_args(on_branch), Intent::BackgroundRead)
            .api(Api::Rest)
            .timeout(TIMEOUT)
            .run()
    };
    let started = Instant::now();
    let run = match read(true).await {
        // The branch may not exist on GitHub; its default branch does.
        // A run that used its whole timeout was offline or stuck, not
        // missing a branch — a second one would hold a permit (and stall
        // the reads behind it) for nothing.
        Err(GhError::Network { .. } | GhError::Unsupported { .. } | GhError::Failed { .. })
            if started.elapsed() < TIMEOUT =>
        {
            read(false).await
        }
        other => other,
    };
    Ok(match run {
        Ok(stdout) => match parse_by_email(&stdout) {
            Some(by_email) => RepoAvatars::Ok { by_email },
            None => RepoAvatars::Failed,
        },
        Err(GhError::NotInstalled | GhError::NotAuthenticated) => RepoAvatars::Unavailable,
        Err(_) => RepoAvatars::Failed,
    })
}

/// `gh` fills `{owner}`, `{repo}` and `{branch}` from the checkout.
fn gh_api_args(on_branch: bool) -> Vec<&'static str> {
    let endpoint = if on_branch {
        "repos/{owner}/{repo}/commits?sha={branch}&per_page=100"
    } else {
        "repos/{owner}/{repo}/commits?per_page=100"
    };
    vec!["api", endpoint, "--jq", JQ]
}

/// Email → avatar from the `--jq` output. `None` for output that is not the
/// expected JSON; pairs missing either half, or an avatar from anywhere but
/// [`AVATAR_ORIGIN`], are skipped. The first pair for an email wins — the
/// list is newest first, so that is the account's current avatar.
fn parse_by_email(json: &str) -> Option<BTreeMap<String, String>> {
    let pairs: Vec<AuthorAvatar> = serde_json::from_str(json).ok()?;
    let mut by_email = BTreeMap::new();
    for pair in pairs {
        let (Some(email), Some(avatar)) = (pair.email, pair.avatar) else {
            continue;
        };
        let email = email.trim().to_ascii_lowercase();
        if email.is_empty() || !avatar.starts_with(AVATAR_ORIGIN) {
            continue;
        }
        by_email.entry(email).or_insert(avatar);
    }
    Some(by_email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_are_keyed_by_lowercased_email() {
        let json = r#"[{"email":"Dev@Acme.dev","avatar":"https://avatars.githubusercontent.com/u/1?v=4"}]"#;
        let by_email = parse_by_email(json).unwrap();
        assert_eq!(
            by_email.get("dev@acme.dev").map(String::as_str),
            Some("https://avatars.githubusercontent.com/u/1?v=4")
        );
    }

    #[test]
    fn the_newest_avatar_for_an_email_wins() {
        let json = r#"[
            {"email":"a@x.dev","avatar":"https://avatars.githubusercontent.com/u/2?v=4"},
            {"email":"a@x.dev","avatar":"https://avatars.githubusercontent.com/u/1?v=4"}
        ]"#;
        assert_eq!(
            parse_by_email(json).unwrap()["a@x.dev"],
            "https://avatars.githubusercontent.com/u/2?v=4"
        );
    }

    #[test]
    fn incomplete_pairs_and_foreign_origins_are_skipped() {
        let json = r#"[
            {"email":null,"avatar":"https://avatars.githubusercontent.com/u/1?v=4"},
            {"email":"b@x.dev","avatar":null},
            {"email":"c@x.dev","avatar":"https://evil.example/c.png"},
            {"email":"  ","avatar":"https://avatars.githubusercontent.com/u/3?v=4"}
        ]"#;
        assert_eq!(parse_by_email(json), Some(BTreeMap::new()));
    }

    #[test]
    fn output_that_is_not_the_expected_json_is_unreadable() {
        assert_eq!(parse_by_email(""), None);
        assert_eq!(parse_by_email(r#"{"message":"Not Found"}"#), None);
    }

    #[test]
    fn the_branch_call_asks_for_the_checked_out_branch() {
        assert!(gh_api_args(true)[1].contains("sha={branch}"));
        assert!(!gh_api_args(false)[1].contains("sha="));
    }

    #[test]
    fn the_wire_shape_is_tagged_by_kind() {
        let mut by_email = BTreeMap::new();
        by_email.insert("a@x.dev".to_string(), "u".to_string());
        assert_eq!(
            serde_json::to_value(RepoAvatars::Ok { by_email }).unwrap(),
            serde_json::json!({ "kind": "ok", "byEmail": { "a@x.dev": "u" } })
        );
        assert_eq!(
            serde_json::to_value(RepoAvatars::Unavailable).unwrap(),
            serde_json::json!({ "kind": "unavailable" })
        );
    }
}
