//! What [`GitCommand`] promises every caller, crossed through its public
//! interface with a fake `git`: a shell script handed over through
//! [`GitCommand::program`]. No `PATH` trick and no environment seam, so
//! nothing outside a call can redirect a real run.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use atlas_git::{GitCommand, GitErrorCode, GitRunError};

/// A fake `git`: a shell script with `body`, in its own temp dir. Run through
/// `/bin/sh` rather than exec'd directly, so a freshly written script cannot
/// hit ETXTBSY when another test thread forks mid-write.
fn fake_git(body: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("git");
    std::fs::write(&path, format!("{body}\n")).unwrap();
    (dir, path)
}

/// `script` standing in for `git`, given `args`, in `cwd`.
fn git_in(cwd: &Path, script: &Path, args: &[&str]) -> GitCommand {
    let mut argv = vec![script.to_str().unwrap()];
    argv.extend_from_slice(args);
    GitCommand::new(cwd, &argv).program("/bin/sh")
}

fn git(script: &Path, args: &[&str]) -> GitCommand {
    git_in(&std::env::temp_dir(), script, args)
}

#[test]
fn every_run_gets_the_standard_environment() {
    let (_dir, script) = fake_git(r#"printf '%s|%s|%s' "$GIT_TERMINAL_PROMPT" "$LC_ALL" "$TERM""#);
    let out = git(&script, &[]).run().unwrap();
    assert_eq!(out.stdout, "0|C|dumb");
    // The raw run is the same process, so the same environment.
    let raw = git(&script, &[]).output().unwrap();
    assert_eq!(raw.stdout_text(), "0|C|dumb");
}

#[test]
fn a_callers_variable_is_added_and_wins_over_the_standard_one() {
    let (_dir, script) =
        fake_git(r#"printf '%s|%s|%s' "$GCM_INTERACTIVE" "$GIT_TERMINAL_PROMPT" "$LC_ALL""#);
    let out = git(&script, &[])
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "en_US.UTF-8")
        .run()
        .unwrap();
    assert_eq!(out.stdout, "never|0|en_US.UTF-8");
}

#[test]
fn arguments_arrive_in_order_and_a_read_takes_no_optional_locks() {
    // `$0` is the first argument after the script when run as `sh script`.
    let (_dir, script) = fake_git(r#"printf '%s,' "$@""#);
    let out = git(&script, &["log", "-n", "two words"]).run().unwrap();
    assert_eq!(out.stdout, "log,-n,two words,");

    // A read: the flag goes before every argument. `echo` stands in for git
    // here because it parses no options and prints its arguments back in
    // order. A script run by `sh` cannot show this: `sh` takes the flag as
    // its own option, and bash and dash word that refusal differently.
    let read = GitCommand::new(std::env::temp_dir(), &["status", "--short"])
        .program("/bin/echo")
        .read_only()
        .output()
        .unwrap();
    assert!(read.success(), "{read:?}");
    assert_eq!(
        read.stdout_text().trim_end(),
        "--no-optional-locks status --short"
    );
}

#[test]
fn stdin_reaches_the_child() {
    let (_dir, script) = fake_git("cat");
    let out = git(&script, &[])
        .stdin(b"a patch\nover stdin\n".to_vec())
        .run()
        .unwrap();
    assert_eq!(out.stdout, "a patch\nover stdin\n");
    // Without one the child reads an empty stdin and is not left waiting.
    let out = git(&script, &[]).run().unwrap();
    assert_eq!(out.stdout, "");
}

#[test]
fn it_runs_in_the_directory_it_was_given() {
    let (_dir, script) = fake_git("pwd -P");
    let here = tempfile::tempdir().unwrap();
    let out = git_in(here.path(), &script, &[]).run().unwrap();
    assert_eq!(
        Path::new(out.stdout.trim()),
        here.path().canonicalize().unwrap()
    );
}

#[test]
fn a_run_about_no_repository_stays_in_the_process_directory() {
    let (_dir, script) = fake_git("pwd -P");
    let out = GitCommand::without_repo(&[script.to_str().unwrap()])
        .program("/bin/sh")
        .run()
        .unwrap();
    assert_eq!(
        Path::new(out.stdout.trim()),
        std::env::current_dir().unwrap().canonicalize().unwrap()
    );
}

#[test]
fn a_timeout_kills_the_child_and_says_so() {
    let (_dir, script) = fake_git("exec sleep 30");
    let started = Instant::now();
    let err = git(&script, &[])
        .timeout(Duration::from_millis(200))
        .output()
        .unwrap_err();
    assert!(
        matches!(err, GitRunError::TimedOut { limit, .. } if limit == Duration::from_millis(200)),
        "{err:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(10));

    // The classified run reports the same expiry as a network failure.
    let err = git(&script, &[])
        .timeout(Duration::from_millis(200))
        .run()
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::NetworkError);
    assert!(err.message.contains("timed out"), "{}", err.message);
}

#[test]
fn a_missing_binary_is_not_installed() {
    let err = GitCommand::new(std::env::temp_dir(), &["status"])
        .program("atlas-no-such-git")
        .output()
        .unwrap_err();
    assert_eq!(err, GitRunError::NotInstalled);

    let err = GitCommand::new(std::env::temp_dir(), &["status"])
        .program("atlas-no-such-git")
        .run()
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::Generic);
    assert!(err.message.contains("git was not found"), "{}", err.message);
}

#[test]
fn a_non_zero_exit_is_classified_from_what_git_wrote() {
    let cases: &[(&str, GitErrorCode)] = &[
        (
            "fatal: not a git repository (or any of the parent directories): .git",
            GitErrorCode::NotARepository,
        ),
        (
            "fatal: Authentication failed for 'https://github.com/x/y.git/'",
            GitErrorCode::AuthFailed,
        ),
    ];
    for (stderr, code) in cases {
        let (_dir, script) = fake_git(r#"echo "$STDERR" >&2; exit 128"#);
        let err = git(&script, &[]).env("STDERR", stderr).run().unwrap_err();
        assert_eq!(err.code, *code, "{stderr}");
        assert_eq!(err.exit_code, Some(128));
        assert_eq!(err.raw_stderr.trim(), *stderr);
    }
}

#[test]
fn an_accepted_exit_code_is_a_success() {
    let (_dir, script) = fake_git("echo differs; exit 1");
    let out = git(&script, &[]).success_codes(&[0, 1]).run().unwrap();
    assert_eq!(out.exit_code, 1);
    assert_eq!(out.stdout, "differs\n");
    assert!(git(&script, &[]).run().is_err());
}

#[test]
fn the_raw_run_returns_any_exit_and_the_bytes_untouched() {
    // Not UTF-8: a blob, or a path in a legacy encoding.
    let (_dir, script) = fake_git(r"printf 'caf\351\000\377'; printf 'why' >&2; exit 3");
    let out = git(&script, &[]).output().unwrap();
    assert_eq!(out.exit_code, Some(3));
    assert!(!out.success());
    assert_eq!(out.stdout, b"caf\xe9\x00\xff");
    assert_eq!(out.stderr_text(), "why");
}

#[test]
fn a_capped_read_stops_at_the_cap_and_kills_the_child() {
    // Endless output: only a kill ends this run.
    let (_dir, script) = fake_git("while :; do echo 0123456789; done");
    let started = Instant::now();
    let out = git(&script, &[]).stdout_capped(100).unwrap();
    assert!(out.truncated);
    assert_eq!(out.bytes.len(), 101, "one byte past the cap");
    assert!(started.elapsed() < Duration::from_secs(10));

    // Under the cap: everything, and git's own verdict.
    let (_dir, script) = fake_git("printf abc; exit 1");
    let out = git(&script, &[]).stdout_capped(100).unwrap();
    assert_eq!(
        (out.bytes.as_slice(), out.truncated, out.success),
        (&b"abc"[..], false, false)
    );
    // Exactly the cap is not truncated.
    let out = git(&script, &[]).stdout_capped(3).unwrap();
    assert!(!out.truncated);
}

#[test]
fn appended_arguments_follow_the_first_ones_and_keep_their_bytes() {
    use std::os::unix::ffi::OsStrExt;
    let (_dir, script) = fake_git(r#"shift; printf '%s,' "$@""#);
    // A file name that is not UTF-8 reaches the child as the same bytes.
    let name = std::ffi::OsStr::from_bytes(b"caf\xe9.txt");
    let out = git(&script, &["first"])
        .args(&["diff", "--"])
        .arg(name)
        .output()
        .unwrap();
    assert_eq!(out.stdout, b"diff,--,caf\xe9.txt,");
}
