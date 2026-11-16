//! Every behaviour of the `gh` runner, crossed through its public interface
//! with a fake `gh`: a shell script in a temp dir.
//!
//! The pauses are process-wide, so any test that sets one, or that would be
//! refused by one (a read), holds [`PAUSE`]. Tests that only run writes do
//! not: a pause never refuses those.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atlas_gh::{now_ms, pause_until, paused_until, Api, GhCommand, GhError, Intent};

/// One permit, held across the awaits of a whole test.
static PAUSE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// Lift both pauses.
fn lift_pauses() {
    for api in Api::ALL {
        pause_until(api, 0);
    }
}

/// A fake `gh`: a shell script with `body`, in its own temp dir. Run through
/// `/bin/sh` rather than exec'd directly, so a freshly written script cannot
/// hit ETXTBSY when another test thread forks mid-write.
fn fake_gh(body: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gh");
    std::fs::write(&path, format!("{body}\n")).unwrap();
    (dir, path)
}

/// `script` standing in for `gh`, given `args`, in the temp directory.
fn gh(script: &Path, args: &[&str], intent: Intent) -> GhCommand {
    let mut argv = vec![script.to_str().unwrap()];
    argv.extend_from_slice(args);
    GhCommand::new(std::env::temp_dir(), argv, intent).program("/bin/sh")
}

/// A failure reduced to what the taxonomy promises: its kind, and the
/// message for the kinds that carry one.
fn shape(error: &GhError) -> (&'static str, Option<&str>) {
    match error {
        GhError::NotInstalled => ("notInstalled", None),
        GhError::NotAuthenticated => ("notAuthenticated", None),
        GhError::RateLimited { .. } => ("rateLimited", None),
        GhError::Network { message } => ("network", Some(message)),
        GhError::Unsupported { message } => ("unsupported", Some(message)),
        GhError::Failed { message } => ("failed", Some(message)),
    }
}

struct Case {
    name: &'static str,
    script: &'static str,
    stdin: Option<&'static str>,
    /// The caller's own variable, `STDERR`, on top of the fixed environment.
    stderr: &'static str,
    /// `Ok(stdout)`, or `Err((kind, message))`.
    want: Result<&'static str, (&'static str, Option<&'static str>)>,
}

const fn ok(name: &'static str, script: &'static str, stdout: &'static str) -> Case {
    Case {
        name,
        script,
        stdin: None,
        stderr: "",
        want: Ok(stdout),
    }
}

/// A run that exits 1 having written `stderr`.
const fn fails(stderr: &'static str, kind: &'static str, message: Option<&'static str>) -> Case {
    Case {
        name: stderr,
        script: r#"printf '%s\n' "$STDERR" >&2; exit 1"#,
        stdin: None,
        stderr,
        want: Err((kind, message)),
    }
}

const CASES: &[Case] = &[
    ok("a successful run returns its stdout", "printf '[]'", "[]"),
    ok(
        "the arguments reach gh in order",
        r#"printf '%s ' "$@""#,
        "pr list --state all ",
    ),
    Case {
        name: "stdin reaches the process",
        script: "cat",
        stdin: Some(r#"{"query":"q"}"#),
        stderr: "",
        want: Ok(r#"{"query":"q"}"#),
    },
    ok(
        "with no stdin the process reads end of file, not a terminal",
        "cat; printf done",
        "done",
    ),
    Case {
        name: "the environment never prompts, nags, pages or colours, and takes the caller's own",
        script: r#"printf '%s|%s|%s|%s|%s' "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$NO_COLOR" "${GH_PAGER-unset}" "$STDERR""#,
        stdin: None,
        stderr: "mine",
        want: Ok("1|1|1||mine"),
    },
    Case {
        name: "exit four means not signed in, whatever stderr says",
        script: "echo 'error connecting to api.github.com' >&2; exit 4",
        stdin: None,
        stderr: "",
        want: Err(("notAuthenticated", None)),
    },
    Case {
        name: "a silent failure names its exit code",
        script: "exit 3",
        stdin: None,
        stderr: "",
        want: Err(("failed", Some("gh exited with status 3."))),
    },
    Case {
        name: "an unrecognised failure carries its first line, less the gh prefix",
        script: "printf '\\n  gh: Not Found (HTTP 404)\\nsecond line\\n' >&2; exit 1",
        stdin: None,
        stderr: "",
        want: Err(("failed", Some("Not Found (HTTP 404)"))),
    },
    // Signed out.
    fails(
        "To get started with GitHub CLI, please run:  gh auth login",
        "notAuthenticated",
        None,
    ),
    fails(
        "You are not logged in to any GitHub hosts.",
        "notAuthenticated",
        None,
    ),
    fails(
        "gh: Authentication required (HTTP 401)",
        "notAuthenticated",
        None,
    ),
    // Rate limits.
    fails(
        "GraphQL: API rate limit exceeded for user ID 1.",
        "rateLimited",
        None,
    ),
    fails("gh: Too Many Requests (HTTP 429)", "rateLimited", None),
    // Not a GitHub checkout.
    fails(
        "none of the git remotes configured for this repository point to a known GitHub host",
        "unsupported",
        Some("none of the git remotes configured for this repository point to a known GitHub host"),
    ),
    fails(
        "fatal: not a git repository (or any of the parent directories): .git",
        "unsupported",
        None,
    ),
    fails("no git remotes found", "unsupported", None),
    fails(
        "GraphQL: Could not resolve to a Repository with the name 'a/b'.",
        "unsupported",
        None,
    ),
    fails(
        "could not determine base repo: no remotes",
        "unsupported",
        None,
    ),
    fails("this is not a GitHub remote", "unsupported", None),
    // The network.
    fails(
        "error connecting to api.github.com",
        "network",
        Some("error connecting to api.github.com"),
    ),
    fails("dial tcp: lookup api.github.com", "network", None),
    fails("Could not resolve host: github.com", "network", None),
    fails("lookup api.github.com: no such host", "network", None),
    fails(
        "net/http: request canceled (Client.Timeout exceeded)",
        "network",
        None,
    ),
    fails("i/o timed out", "network", None),
    fails("read: connection reset by peer", "network", None),
    fails("remote error: tls: handshake failure", "network", None),
    fails("gh: Bad Gateway (HTTP 502)", "network", None),
    fails("gh: Service Unavailable (HTTP 503)", "network", None),
    fails("gh: Gateway Timeout (HTTP 504)", "network", None),
    // Rate limit outranks the network list, which a refusal's wording can
    // brush against.
    fails(
        "secondary rate limit: connection throttled",
        "rateLimited",
        None,
    ),
];

#[tokio::test]
async fn runs_end_the_way_their_exit_and_stderr_say() {
    // The rate-limit rows pause the APIs; held so no read meets a pause.
    let _pause = PAUSE.acquire().await.unwrap();
    for case in CASES {
        let (_dir, script) = fake_gh(case.script);
        let mut command = gh(&script, &["pr", "list", "--state", "all"], Intent::Write)
            .env("STDERR", case.stderr);
        if let Some(stdin) = case.stdin {
            command = command.stdin(stdin.as_bytes().to_vec());
        }
        let got = command.run().await;
        match (&got, &case.want) {
            (Ok(stdout), Ok(want)) => assert_eq!(stdout, want, "{}", case.name),
            (Err(error), Err((kind, message))) => {
                let (got_kind, got_message) = shape(error);
                assert_eq!(got_kind, *kind, "{}", case.name);
                if message.is_some() {
                    assert_eq!(got_message, *message, "{}", case.name);
                }
            }
            _ => panic!("{}: got {got:?}", case.name),
        }
    }
    lift_pauses();
}

#[tokio::test]
async fn the_raw_output_keeps_the_exit_code_stdout_and_all_of_stderr() {
    // `gh api -i` exits 1 on a 304 and still prints the answer.
    let (_dir, script) = fake_gh("printf 'HTTP/2.0 304'; printf 'one\\ntwo\\n' >&2; exit 1");
    let output = gh(&script, &[], Intent::Write).output().await.unwrap();
    assert!(!output.success());
    assert_eq!(output.exit, Some(1));
    assert_eq!(output.stdout, b"HTTP/2.0 304");
    assert_eq!(output.stderr, "one\ntwo\n");
    assert_eq!(
        output.failure(),
        GhError::Failed {
            message: "one".into()
        }
    );
}

#[tokio::test]
async fn a_missing_binary_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let got = GhCommand::new(std::env::temp_dir(), ["pr", "list"], Intent::Write)
        .program(dir.path().join("gh"))
        .run()
        .await;
    assert_eq!(got, Err(GhError::NotInstalled));
}

#[tokio::test]
async fn a_directory_that_is_gone_is_unsupported_not_a_missing_gh() {
    // Even with no binary either: the directory is asked about first.
    let dir = tempfile::tempdir().unwrap();
    let got = GhCommand::new(dir.path().join("gone"), ["pr", "list"], Intent::Write)
        .program(dir.path().join("gh"))
        .run()
        .await;
    assert_eq!(
        got,
        Err(GhError::Unsupported {
            message: "not a git repository".into()
        })
    );
}

#[tokio::test]
async fn a_run_past_its_timeout_is_killed() {
    // `exec` so the kill reaches the sleeper itself, which holds stdout.
    let (dir, script) = fake_gh(r#"echo $$ > "$1/pid"; exec sleep 30"#);
    let started = Instant::now();
    let got = gh(&script, &[dir.path().to_str().unwrap()], Intent::Write)
        .timeout(Duration::from_millis(500))
        .run()
        .await;
    assert_eq!(
        got,
        Err(GhError::Network {
            message: "GitHub did not answer in time.".into()
        })
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
    let alive = atlas_process::command("kill")
        .args(["-0", pid.trim()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(!alive, "the timed-out process is still running");
}

/// How many of `dir`'s marker files exist: one per fake `gh` now running.
fn running(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("run-"))
        .count()
}

/// Wait until `count` fake `gh` are running in `dir`.
async fn wait_for_running(dir: &Path, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while running(dir) < count {
        assert!(
            Instant::now() < deadline,
            "{count} calls never ran together"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn interactive_calls_and_background_reads_each_wait_only_on_their_own_pool() {
    // Reads run here, which a pause left by another test would refuse.
    let _pause = PAUSE.acquire().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let here = dir.path().to_str().unwrap().to_string();
    // Holds its permit until `go` appears.
    let (_d, blocker) =
        fake_gh(r#": > "$1/run-$$"; while [ ! -e "$1/go" ]; do sleep 0.02; done; printf held"#);
    let (_d2, quick) = fake_gh("printf ran");

    // What the user is waiting on, reads and writes alike, shares four.
    let mut held: Vec<_> = [
        Intent::Write,
        Intent::InteractiveRead,
        Intent::Write,
        Intent::InteractiveRead,
    ]
    .into_iter()
    .map(|intent| tokio::spawn(gh(&blocker, &[&here], intent).run()))
    .collect();
    wait_for_running(dir.path(), 4).await;

    // That pool is spent: a fifth interactive call waits...
    let fifth = tokio::spawn(gh(&quick, &[], Intent::InteractiveRead).run());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !fifth.is_finished(),
        "a fifth interactive call got a permit"
    );
    // ...while a long verb and an unmetered fetch take no permit, and a
    // background read has a pool of its own.
    for intent in [Intent::LongWrite, Intent::Unmetered, Intent::BackgroundRead] {
        assert_eq!(
            gh(&quick, &[], intent).run().await.as_deref(),
            Ok("ran"),
            "{intent:?}"
        );
    }

    // Background reads share two, so a sweep of them can hold only those.
    held.extend((0..2).map(|_| tokio::spawn(gh(&blocker, &[&here], Intent::BackgroundRead).run())));
    wait_for_running(dir.path(), 6).await;
    let third = tokio::spawn(gh(&quick, &[], Intent::BackgroundRead).run());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!third.is_finished(), "a third background read got a permit");

    std::fs::write(dir.path().join("go"), "").unwrap();
    for call in held {
        assert_eq!(call.await.unwrap().as_deref(), Ok("held"));
    }
    assert_eq!(fifth.await.unwrap().as_deref(), Ok("ran"));
    assert_eq!(third.await.unwrap().as_deref(), Ok("ran"));
}

/// A hook that leaves a process in the background (`gh repo clone` and
/// `gh pr checkout` run the repository's own) hands it the pipes. `gh` is
/// done; the run must be too, with what was written by then, not wait out
/// that process or the time limit.
#[tokio::test]
async fn a_run_ends_when_gh_exits_though_something_it_started_holds_the_pipes() {
    let (_d, script) = fake_gh("echo ran\n(sleep 20; echo late) &\nexit 0");
    let started = Instant::now();
    let output = gh(&script, &[], Intent::LongWrite)
        .timeout(Duration::from_secs(60))
        .output()
        .await
        .unwrap();
    assert!(output.success());
    assert_eq!(output.stdout, b"ran\n");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_pause_refuses_reads_of_its_api_without_running_them_and_lets_writes_through() {
    let _pause = PAUSE.acquire().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let here = dir.path().to_str().unwrap().to_string();
    let (_d, script) = fake_gh(r#": > "$1/run-$$"; printf ran"#);
    let until = now_ms() + 60_000;

    for (paused, other) in [(Api::Rest, Api::Graphql), (Api::Graphql, Api::Rest)] {
        lift_pauses();
        pause_until(paused, until);
        let before = running(dir.path());
        for intent in [Intent::BackgroundRead, Intent::InteractiveRead] {
            let refused = Err(GhError::RateLimited {
                retry_at: Some(until),
            });
            assert_eq!(
                gh(&script, &[&here], intent).api(paused).run().await,
                refused,
                "{intent:?} of the paused {paused:?}"
            );
            // A read that does not say which API it asks could be this one.
            assert_eq!(
                gh(&script, &[&here], intent).run().await,
                refused,
                "{intent:?} of no named API, {paused:?} paused"
            );
        }
        assert_eq!(running(dir.path()), before, "a refused read still ran gh");

        // The other API's quota is its own: its reads run.
        for intent in [Intent::BackgroundRead, Intent::InteractiveRead] {
            assert_eq!(
                gh(&script, &[&here], intent)
                    .api(other)
                    .run()
                    .await
                    .as_deref(),
                Ok("ran"),
                "{intent:?} of {other:?} while {paused:?} is paused"
            );
        }
        for intent in [Intent::Write, Intent::LongWrite, Intent::Unmetered] {
            assert_eq!(
                gh(&script, &[&here], intent)
                    .api(paused)
                    .run()
                    .await
                    .as_deref(),
                Ok("ran"),
                "{intent:?}"
            );
        }
    }

    // Lifted, a read of it runs again.
    lift_pauses();
    assert_eq!(
        gh(&script, &[&here], Intent::BackgroundRead)
            .api(Api::Graphql)
            .run()
            .await
            .as_deref(),
        Ok("ran")
    );
}

const QUOTA_REFUSAL: &str =
    "echo 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' >&2; exit 1";

#[tokio::test]
async fn a_rate_limited_run_pauses_the_api() {
    let _pause = PAUSE.acquire().await.unwrap();
    let (_d, refused) = fake_gh(QUOTA_REFUSAL);
    let (_d2, quick) = fake_gh("printf ran");

    // An image host's refusal is not the API's.
    lift_pauses();
    let unmetered = gh(&refused, &[], Intent::Unmetered).run().await;
    assert_eq!(unmetered, Err(GhError::RateLimited { retry_at: None }));
    for api in Api::ALL {
        assert_eq!(paused_until(api, now_ms()), None);
    }

    // Any other run's is, a user's write included, and whether or not the
    // caller ever classifies the output.
    let before = now_ms();
    let output = gh(&refused, &[], Intent::LongWrite)
        .api(Api::Rest)
        .output()
        .await
        .unwrap();
    let until = paused_until(Api::Rest, now_ms()).expect("the refusal paused the API");
    assert!(until > before);
    assert_eq!(
        output.failure(),
        GhError::RateLimited {
            retry_at: Some(until)
        }
    );
    assert_eq!(
        gh(&quick, &[], Intent::BackgroundRead)
            .api(Api::Rest)
            .run()
            .await,
        Err(GhError::RateLimited {
            retry_at: Some(until)
        })
    );

    // A pause GitHub named a later end for is never shortened.
    let named = now_ms() + 3_600_000;
    pause_until(Api::Rest, named);
    let _ = gh(&refused, &[], Intent::Write).api(Api::Rest).run().await;
    assert_eq!(paused_until(Api::Rest, now_ms()), Some(named));
    lift_pauses();
}

/// GitHub counts the REST and GraphQL quotas separately: one running out
/// must not hold the other's reads.
#[tokio::test]
async fn a_quota_refusal_pauses_only_the_api_it_came_from() {
    let _pause = PAUSE.acquire().await.unwrap();
    let (_d, refused) = fake_gh(QUOTA_REFUSAL);
    let (_d2, quick) = fake_gh("printf ran");

    for (asked, other) in [(Api::Rest, Api::Graphql), (Api::Graphql, Api::Rest)] {
        lift_pauses();
        let got = gh(&refused, &[], Intent::BackgroundRead)
            .api(asked)
            .run()
            .await;
        assert!(
            matches!(got, Err(GhError::RateLimited { .. })),
            "{asked:?}: {got:?}"
        );
        assert!(paused_until(asked, now_ms()).is_some(), "{asked:?}");
        assert_eq!(paused_until(other, now_ms()), None, "{asked:?} refused");
        assert_eq!(
            gh(&quick, &[], Intent::InteractiveRead)
                .api(other)
                .run()
                .await
                .as_deref(),
            Ok("ran"),
            "a read of {other:?} after {asked:?} was refused"
        );
    }
    lift_pauses();
}

/// The refusals that are not one quota running out pause both APIs: a
/// secondary limit (GitHub asking this user to slow down, whatever they ask
/// next), a 429 (which can be either kind), and any refusal of a run that
/// did not say which API it asks.
#[tokio::test]
async fn a_refusal_that_is_not_one_quota_running_out_pauses_both_apis() {
    let _pause = PAUSE.acquire().await.unwrap();
    let cases: [(&str, &str, Option<Api>); 4] = [
        (
            "a secondary limit, on REST",
            "echo 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)' >&2; exit 1",
            Some(Api::Rest),
        ),
        (
            "a secondary limit, on GraphQL",
            "echo 'gh: You have exceeded a secondary rate limit. (HTTP 403)' >&2; exit 1",
            Some(Api::Graphql),
        ),
        (
            "a 429",
            "echo 'gh: Too Many Requests (HTTP 429)' >&2; exit 1",
            Some(Api::Rest),
        ),
        ("a quota refusal of a run that named no API", QUOTA_REFUSAL, None),
    ];
    for (name, script, api) in cases {
        lift_pauses();
        let (_d, refused) = fake_gh(script);
        let mut command = gh(&refused, &[], Intent::Write);
        if let Some(api) = api {
            command = command.api(api);
        }
        let got = command.run().await;
        assert!(
            matches!(got, Err(GhError::RateLimited { .. })),
            "{name}: {got:?}"
        );
        for paused in Api::ALL {
            assert!(
                paused_until(paused, now_ms()).is_some(),
                "{name}: {paused:?} is not paused"
            );
        }
    }
    lift_pauses();
}
