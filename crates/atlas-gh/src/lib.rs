//! The single `gh` spawn chokepoint: every run of the user's GitHub CLI in
//! Atlas goes through [`GhCommand`].
//!
//! Atlas never holds a GitHub token. `gh` already holds the user's own
//! credentials and knows which GitHub repository a checkout's remote points
//! at, so asking it costs no token handling at all. This crate owns the
//! process side of that and nothing else:
//!
//! - **One environment.** Never a prompt nobody can see, never an upgrade
//!   nag, a pager or colour codes in output that is about to be parsed.
//! - **A bound on every run.** A timeout that kills the child, and a
//!   directory guard so a removed worktree is not mistaken for a missing
//!   binary.
//! - **One budget.** Two pools of permits for API requests, one for what
//!   the user is waiting on and one for background reads, and a pause per
//!   API ([`Api`]), set when GitHub refuses for its rate limit. What a call
//!   says it is ([`Intent`]) decides which pool it waits on and whether a
//!   pause refuses it.
//! - **One failure taxonomy** ([`GhError`]) for a run that produced no
//!   answer.
//!
//! What an answer *means* is the caller's: the pull-request surface reads
//! `gh api -i` output as HTTP, and keeps the quota accounting that needs its
//! headers. It reads and extends the pauses here rather than keeping its own.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

/// How many `gh` processes run at once for what the user is waiting on
/// ([`Intent::InteractiveRead`] and [`Intent::Write`]), across every surface
/// and repository. Opening a pull request reads four things side by side.
/// GitHub's secondary limits punish bursts of concurrent requests, so this
/// stays a small pool rather than an open door: with
/// [`BACKGROUND_PERMITS`] it is six, under the eight concurrent requests
/// GitHub treats as polite, and each permit is a whole process, not a
/// pooled connection.
static INTERACTIVE_PERMITS: Semaphore = Semaphore::const_new(4);

/// How many `gh` processes run at once for [`Intent::BackgroundRead`]. A
/// pool of their own, because the wait for a permit has no limit: a sidebar
/// listing sessions from many worktrees spawns one avatar read per
/// repository in the same instant, and in a shared pool those held every
/// permit while a pull request the user had just opened waited behind them.
static BACKGROUND_PERMITS: Semaphore = Semaphore::const_new(2);

/// Each API is paused until its time here (epoch milliseconds), indexed by
/// [`Api`]; zero when it is not. GitHub counts the REST and GraphQL quotas
/// separately, so one running out says nothing about the other.
static PAUSED_UNTIL: [AtomicI64; 2] = [AtomicI64::new(0), AtomicI64::new(0)];

/// How long a rate-limit refusal that named no retry time pauses for.
const REFUSAL_COOLDOWN_MS: i64 = 30_000;

/// How long a run keeps at its pipes after `gh` itself has exited: the same
/// grace, for the same reason, as `atlas-git`'s `STREAM_DRAIN_GRACE`.
const PIPE_DRAIN_GRACE: Duration = Duration::from_millis(500);

/// What a run gets when its caller sets no [`GhCommand::timeout`].
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// `gh`'s documented exit code for "authentication required". Checked
/// before stderr because a signed-out `gh` words its hint differently across
/// versions, and the code is the part it promises.
const EXIT_AUTH_REQUIRED: i32 = 4;

/// One of GitHub's two APIs. Each has a quota of its own, and so a pause of
/// its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Api {
    Rest,
    Graphql,
}

impl Api {
    pub const ALL: [Api; 2] = [Api::Rest, Api::Graphql];

    fn pause(self) -> &'static AtomicI64 {
        &PAUSED_UNTIL[self as usize]
    }
}

/// What a call is, which decides what it waits for and whether a pause
/// refuses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    /// A read nobody asked for just now (avatars, a status probe, a sweep).
    /// Takes a background permit; refused while its API is paused.
    BackgroundRead,
    /// A read the user is waiting on. Takes an interactive permit; refused
    /// while its API is paused, since GitHub would refuse it too. Above this
    /// crate a quota's reserve is kept for it as well.
    InteractiveRead,
    /// Something the user did (open a pull request, create a repository).
    /// Takes an interactive permit; always runs, pause or not.
    Write,
    /// A user-initiated verb that runs for minutes and spends most of them
    /// in `git` (`gh pr checkout`, `gh repo clone`). Takes no permit, so a
    /// clone never queues the reads behind it; always runs.
    LongWrite,
    /// Not an API request at all (an image host). No permit, no pause, and
    /// its failure pauses nothing.
    Unmetered,
}

/// Why a `gh` run has no answer. The kinds are the ones the pull-request
/// surface reports to the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhError {
    /// The binary could not be started (not installed, not on `PATH`).
    NotInstalled,
    /// `gh` says it needs `gh auth login`.
    NotAuthenticated,
    /// GitHub refused for its rate limit, or the API is paused after such a
    /// refusal. `retry_at` is epoch milliseconds.
    RateLimited { retry_at: Option<i64> },
    /// Offline, a dead VPN, or too slow: worth asking again soon.
    Network { message: String },
    /// Not a GitHub remote, or not a repository: asking again will not help.
    Unsupported { message: String },
    /// Anything else. `message` is the first line `gh` wrote to stderr.
    Failed { message: String },
}

impl std::fmt::Display for GhError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GhError::NotInstalled => f.write_str("The GitHub CLI (gh) is not installed."),
            GhError::NotAuthenticated => {
                f.write_str("The GitHub CLI is not signed in. Run `gh auth login`.")
            }
            GhError::RateLimited { .. } => f.write_str("GitHub's rate limit was reached."),
            GhError::Network { message }
            | GhError::Unsupported { message }
            | GhError::Failed { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for GhError {}

/// A `gh` process that ran to its exit, whatever the exit was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhOutput {
    /// `None` when a signal ended it.
    pub exit: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl GhOutput {
    pub fn success(&self) -> bool {
        self.exit == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// What this run means when it produced no answer, from its exit code
    /// and stderr. Only the classification and one line of stderr leave;
    /// never a command line.
    pub fn failure(&self) -> GhError {
        classify(self.exit, &self.stderr)
    }
}

/// One `gh` invocation. Build with [`GhCommand::new`], chain options, then
/// [`run`](Self::run) it for its stdout or take the raw
/// [`output`](Self::output).
#[derive(Debug, Clone)]
pub struct GhCommand {
    program: OsString,
    cwd: PathBuf,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    intent: Intent,
    api: Option<Api>,
}

impl GhCommand {
    pub fn new<I, S>(cwd: impl Into<PathBuf>, args: I, intent: Intent) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        GhCommand {
            program: OsString::from("gh"),
            cwd: cwd.into(),
            args: args
                .into_iter()
                .map(|a| a.as_ref().to_os_string())
                .collect(),
            envs: Vec::new(),
            stdin: None,
            timeout: DEFAULT_TIMEOUT,
            intent,
            api: None,
        }
    }

    /// Which API this run asks (`gh api graphql` or `gh api <path>`), so a
    /// pause of the other does not refuse it and a quota refusal pauses only
    /// this one. Left unset for a verb whose requests are `gh`'s own choice
    /// (`gh pr create`): that is refused, as a read, while either API is
    /// paused, and its refusal pauses both.
    pub fn api(mut self, api: Api) -> Self {
        self.api = Some(api);
        self
    }

    /// Test seam: run another program in place of `gh`. A parameter rather
    /// than an environment variable or a `PATH` trick, so nothing outside
    /// the call can redirect a real run.
    pub fn program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    /// One more variable on top of the fixed environment (the `git` settings
    /// a checkout needs, say).
    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.envs.push((key.into(), value.into()));
        self
    }

    /// Bytes piped to stdin (a request body, a pull request's description),
    /// so no value of the user's passes through a command line.
    pub fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// Kill `gh` if it has not exited after `limit`. It goes to the network,
    /// so a captive portal or a dead VPN would otherwise hold the call for
    /// as long as the TCP stack cares to wait.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = limit;
        self
    }

    /// Run to exit 0 and return stdout; any other exit is its
    /// [`GhOutput::failure`]. For a verb whose exit code is the whole story.
    pub async fn run(self) -> Result<String, GhError> {
        let output = self.output().await?;
        if output.success() {
            Ok(output.stdout_text())
        } else {
            Err(output.failure())
        }
    }

    /// Run to exit and return what it printed, whatever the exit code: for a
    /// caller that reads the answer itself (`gh api -i` exits non-zero on a
    /// 304 and still prints one) or needs more of stderr than one line.
    ///
    /// `Err` means no process ran to its end: no binary, no directory, a
    /// read refused by the pause, or a timeout (the only
    /// [`GhError::Network`] from here).
    pub async fn output(self) -> Result<GhOutput, GhError> {
        // A directory that is gone (a removed worktree) fails the spawn with
        // the same NotFound as a missing binary; it must not read as "no
        // `gh`".
        if !self.cwd.is_dir() {
            return Err(GhError::Unsupported {
                message: "not a git repository".into(),
            });
        }
        let api = self.api;
        let pool = match self.intent {
            Intent::BackgroundRead => Some(&BACKGROUND_PERMITS),
            Intent::InteractiveRead | Intent::Write => Some(&INTERACTIVE_PERMITS),
            Intent::LongWrite | Intent::Unmetered => None,
        };
        let held_back = || {
            let read = matches!(
                self.intent,
                Intent::BackgroundRead | Intent::InteractiveRead
            );
            match paused_for(api, now_ms()) {
                Some(until) if read => Err(GhError::RateLimited {
                    retry_at: Some(until),
                }),
                _ => Ok(()),
            }
        };
        held_back()?;
        let _permit = match pool {
            Some(pool) => Some(pool.acquire().await.map_err(|_| GhError::Failed {
                message: "Atlas is shutting down.".into(),
            })?),
            None => None,
        };
        // Again: a pause can start while this run waits for a permit.
        held_back()?;
        let metered = self.intent != Intent::Unmetered;
        let output = self.spawn_and_wait().await?;
        if metered && !output.success() {
            let lower = output.stderr.to_ascii_lowercase();
            if says_rate_limited(&lower) {
                // Recorded here, not in `failure`, so no caller can see a
                // refusal and forget to slow down. Never shortens a pause a
                // caller set from the time GitHub named.
                let until = now_ms() + REFUSAL_COOLDOWN_MS;
                for paused in refused_apis(api, &lower) {
                    paused.pause().fetch_max(until, Ordering::Relaxed);
                }
            }
        }
        Ok(output)
    }

    async fn spawn_and_wait(self) -> Result<GhOutput, GhError> {
        let mut cmd = atlas_process::async_command(&self.program);
        cmd.args(&self.args)
            .current_dir(&self.cwd)
            // Never wait on a prompt nobody can see, never print upgrade
            // nags, never page or colour output that is about to be parsed.
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .env("GH_PAGER", "")
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // A caller that stops waiting (a cancelled command) must not
            // leave `gh` running.
            .kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(GhError::NotInstalled)
            }
            Err(e) => {
                return Err(GhError::Failed {
                    message: e.to_string(),
                })
            }
        };
        let pipe = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let input = self.stdin;
        let mut out = Vec::new();
        let mut err = Vec::new();
        // Stdin is fed while both pipes drain, so neither a large body nor a
        // large answer can fill a pipe and stall the child.
        let work = async {
            let pipes = async {
                let feed = async {
                    if let (Some(mut pipe), Some(bytes)) = (pipe, input) {
                        // A child that exits early closes the pipe; its own
                        // answer says why.
                        let _ = pipe.write_all(&bytes).await;
                    }
                };
                tokio::join!(feed, drain(stdout, &mut out), drain(stderr, &mut err));
            };
            tokio::pin!(pipes);
            let mut pipes_done = false;
            let status = loop {
                tokio::select! {
                    status = child.wait() => break status,
                    () = &mut pipes, if !pipes_done => pipes_done = true,
                }
            };
            // Done when `gh` exits, not when its pipes close. A process it
            // started can hold them open after it is gone: `git` and its
            // helpers briefly, a hook that left something in the background
            // (a clone runs the repository's own) for as long as that lives.
            // Output already in flight gets the grace to arrive, and what
            // was read by then is the answer.
            if !pipes_done {
                let _ = tokio::time::timeout(PIPE_DRAIN_GRACE, &mut pipes).await;
            }
            status
        };
        let finished = tokio::time::timeout(self.timeout, work).await;
        match finished {
            Ok(Ok(status)) => Ok(GhOutput {
                exit: status.code(),
                stdout: out,
                stderr: String::from_utf8_lossy(&err).into_owned(),
            }),
            Ok(Err(e)) => Err(GhError::Failed {
                message: e.to_string(),
            }),
            Err(_) => {
                // Killed and reaped before answering, so a timed-out run
                // leaves no process behind.
                let _ = child.kill().await;
                Err(GhError::Network {
                    message: "GitHub did not answer in time.".into(),
                })
            }
        }
    }
}

/// Everything a pipe carries until it closes, appended to `into` as it
/// arrives, so a caller that stops waiting keeps what was read. A read error
/// ends it early: the exit code and what did arrive still classify the run.
async fn drain(pipe: Option<impl AsyncRead + Unpin>, into: &mut Vec<u8>) {
    let Some(mut pipe) = pipe else { return };
    // A `Vec` always has room, so reading nothing is the end of the pipe.
    while matches!(pipe.read_buf(into).await, Ok(read) if read > 0) {}
}

/// Now, in epoch milliseconds: the clock the pause is kept in.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Until when `api` is paused (epoch milliseconds), if it is at `now_ms`.
pub fn paused_until(api: Api, now_ms: i64) -> Option<i64> {
    let until = api.pause().load(Ordering::Relaxed);
    (until > now_ms).then_some(until)
}

/// Pause `api` until `at_ms`, replacing any pause of it in force: for the
/// caller that read the time GitHub named from an answer's headers. Zero
/// lifts it.
pub fn pause_until(api: Api, at_ms: i64) {
    api.pause().store(at_ms, Ordering::Relaxed);
}

/// The pause that holds a run back: its own API's, or for a run that named
/// none, the later of the two.
fn paused_for(api: Option<Api>, now_ms: i64) -> Option<i64> {
    match api {
        Some(api) => paused_until(api, now_ms),
        None => Api::ALL
            .into_iter()
            .filter_map(|api| paused_until(api, now_ms))
            .max(),
    }
}

fn says_rate_limited(lower: &str) -> bool {
    lower.contains("rate limit") || lower.contains("http 429")
}

/// Which APIs a refusal pauses, from `gh`'s (lowercased) stderr. A quota
/// that ran out pauses the API it was spent on, when the run named one.
/// Everything else pauses both: a secondary limit is GitHub asking this user
/// to slow down whatever they ask next, a 429 can be either kind, and a verb
/// that named no API could have spent either quota.
fn refused_apis(api: Option<Api>, lower: &str) -> Vec<Api> {
    let secondary = lower.contains("secondary") || lower.contains("http 429");
    match api {
        Some(api) if !secondary => vec![api],
        _ => Api::ALL.to_vec(),
    }
}

/// One taxonomy for a run with no answer. The order matters: a signed-out
/// `gh` and a rate limit are true whatever else stderr mentions, and the
/// network list is loose ("connection", "tls") so it goes last.
fn classify(exit: Option<i32>, stderr: &str) -> GhError {
    let lower = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if exit == Some(EXIT_AUTH_REQUIRED)
        || has(&["gh auth login", "not logged in", "authentication required"])
    {
        return GhError::NotAuthenticated;
    }
    if says_rate_limited(&lower) {
        // The output does not say which API was asked, so this is the later
        // of the two pauses. A caller that knows asks [`paused_until`].
        return GhError::RateLimited {
            retry_at: paused_for(None, now_ms()),
        };
    }
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.trim_start_matches("gh: ").to_string())
        .unwrap_or_else(|| match exit {
            Some(code) => format!("gh exited with status {code}."),
            None => "gh was stopped before it finished.".into(),
        });
    if has(&[
        "none of the git remotes",
        "not a git repository",
        "no git remotes",
        "could not resolve to a repository",
        "could not determine",
        "not a github",
    ]) {
        return GhError::Unsupported { message };
    }
    if has(&[
        "error connecting",
        "dial tcp",
        "could not resolve host",
        "no such host",
        "timeout",
        "timed out",
        "connection",
        "tls",
        "http 502",
        "http 503",
        "http 504",
    ]) {
        return GhError::Network { message };
    }
    GhError::Failed { message }
}
