//! Every behaviour of the `gh` runner, crossed through its public interface
//! with a fake `gh`: a shell script in a temp dir.
//!
//! The pause is process-wide, so any test that sets it, or that would be
//! refused by it (a read), holds [`PAUSE`]. Tests that only run writes do
//! not: a pause never refuses those.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atlas_gh::{now_ms, pause_until, paused_until, GhCommand, GhError, Intent};

/// One permit, held across the awaits of a whole test.
static PAUSE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

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
    // The rate-limit rows pause the API; held so no read meets that pause.
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
    pause_until(0);
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

#[tokio::test]
async fn six_api_calls_run_at_once_and_a_long_verb_waits_for_none_of_them() {
    let dir = tempfile::tempdir().unwrap();
    let here = dir.path().to_str().unwrap().to_string();
    // Holds its permit until `go` appears.
    let (_d, blocker) =
        fake_gh(r#": > "$1/run-$$"; while [ ! -e "$1/go" ]; do sleep 0.02; done; printf held"#);
    let (_d2, quick) = fake_gh("printf ran");

    let held: Vec<_> = (0..6)
        .map(|_| tokio::spawn(gh(&blocker, &[&here], Intent::Write).run()))
        .collect();
    let deadline = Instant::now() + Duration::from_secs(20);
    while running(dir.path()) < 6 {
        assert!(Instant::now() < deadline, "six calls never ran together");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // The pool is spent: a seventh API call waits...
    let seventh = tokio::spawn(gh(&quick, &[], Intent::Write).run());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!seventh.is_finished(), "a seventh API call got a permit");
    // ...while a long verb and an unmetered fetch take no permit.
    for intent in [Intent::LongWrite, Intent::Unmetered] {
        assert_eq!(gh(&quick, &[], intent).run().await.as_deref(), Ok("ran"));
    }

    std::fs::write(dir.path().join("go"), "").unwrap();
    for call in held {
        assert_eq!(call.await.unwrap().as_deref(), Ok("held"));
    }
    assert_eq!(seventh.await.unwrap().as_deref(), Ok("ran"));
}

#[tokio::test]
async fn a_pause_refuses_reads_without_running_them_and_lets_writes_through() {
    let _pause = PAUSE.acquire().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let here = dir.path().to_str().unwrap().to_string();
    let (_d, script) = fake_gh(r#": > "$1/run-$$"; printf ran"#);
    let until = now_ms() + 60_000;
    pause_until(until);

    for intent in [Intent::BackgroundRead, Intent::InteractiveRead] {
        assert_eq!(
            gh(&script, &[&here], intent).run().await,
            Err(GhError::RateLimited {
                retry_at: Some(until)
            }),
            "{intent:?}"
        );
    }
    assert_eq!(running(dir.path()), 0, "a refused read still ran gh");

    for intent in [Intent::Write, Intent::LongWrite, Intent::Unmetered] {
        assert_eq!(
            gh(&script, &[&here], intent).run().await.as_deref(),
            Ok("ran"),
            "{intent:?}"
        );
    }

    // Lifted, a background read runs again.
    pause_until(0);
    assert_eq!(
        gh(&script, &[&here], Intent::BackgroundRead)
            .run()
            .await
            .as_deref(),
        Ok("ran")
    );
}

#[tokio::test]
async fn a_rate_limited_run_pauses_the_api() {
    let _pause = PAUSE.acquire().await.unwrap();
    let (_d, refused) = fake_gh("echo 'gh: API rate limit exceeded (HTTP 403)' >&2; exit 1");
    let (_d2, quick) = fake_gh("printf ran");

    // An image host's refusal is not the API's.
    pause_until(0);
    let unmetered = gh(&refused, &[], Intent::Unmetered).run().await;
    assert_eq!(unmetered, Err(GhError::RateLimited { retry_at: None }));
    assert_eq!(paused_until(now_ms()), None);

    // Any other run's is, a user's write included, and whether or not the
    // caller ever classifies the output.
    let before = now_ms();
    let output = gh(&refused, &[], Intent::LongWrite).output().await.unwrap();
    let until = paused_until(now_ms()).expect("the refusal paused the API");
    assert!(until > before);
    assert_eq!(
        output.failure(),
        GhError::RateLimited {
            retry_at: Some(until)
        }
    );
    assert_eq!(
        gh(&quick, &[], Intent::BackgroundRead).run().await,
        Err(GhError::RateLimited {
            retry_at: Some(until)
        })
    );

    // A pause GitHub named a later end for is never shortened.
    let named = now_ms() + 3_600_000;
    pause_until(named);
    let _ = gh(&refused, &[], Intent::Write).run().await;
    assert_eq!(paused_until(now_ms()), Some(named));
    pause_until(0);
}
