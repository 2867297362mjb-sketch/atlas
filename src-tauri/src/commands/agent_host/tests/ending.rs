//! Every way a session ends, and what each leaves behind.
//!
//! One test per path. Each opens a session on the scripted agent, ends it,
//! and reads back [`Residue`]: everything the host and the stack beneath it
//! still hold for that session id, in one value. Beside it, what the path
//! announced on its way: the end notices, the disconnect notices on the
//! wire, the `session/close` the agent was sent.

use super::*;
use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope};

const SESSION: &str = "s-end";

#[derive(Default)]
struct Deltas(std::sync::Mutex<Vec<SessionDeltaEnvelope>>);

impl DeltaSink for Deltas {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.0.lock().unwrap().push(envelope);
    }
}

impl Deltas {
    fn disconnects(&self) -> Vec<String> {
        let deltas = self.0.lock().unwrap();
        deltas
            .iter()
            .filter_map(|e| match &e.delta {
                SessionDelta::AgentDisconnected { reason } => Some(reason.clone()),
                _ => None,
            })
            .collect()
    }

    fn holds(&self) -> Vec<bool> {
        let deltas = self.0.lock().unwrap();
        deltas
            .iter()
            .filter_map(|e| match &e.delta {
                SessionDelta::HoldChanged { held } => Some(*held),
                _ => None,
            })
            .collect()
    }
}

/// Ends the test binary if a test here is still running after
/// [`Watchdog::LIMIT`]. A timeout on a future cannot do this: the hang this
/// guards against is a thread blocked on a lock, which no executor can
/// interrupt, and a blocked test holds the shared build lock for as long as
/// it is left.
struct Watchdog(Arc<std::sync::atomic::AtomicBool>);

impl Watchdog {
    const LIMIT: std::time::Duration = std::time::Duration::from_secs(30);

    fn arm() -> Self {
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watched = done.clone();
        let test = std::thread::current().name().unwrap_or("?").to_owned();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Self::LIMIT {
                if watched.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            eprintln!("{test} is still running after {:?}: aborting", Self::LIMIT);
            std::process::abort();
        });
        Self(done)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What is still held for one session id, everywhere it can be held.
#[derive(Debug, Default, PartialEq, Eq)]
struct Residue {
    /// The host's record: the session is open as far as any command knows.
    record: bool,
    holds: usize,
    /// A turn controller (queue, pause, running turn).
    turn_control: bool,
    queued: usize,
    /// A remote-control seat.
    seat: bool,
    /// The manager's handle on the thread.
    manager_handle: bool,
    /// The wire projection, which owns the thread and through it the
    /// connection.
    projection: bool,
    /// A history row the id still reaches: through its live binding, or
    /// because the session was sent to and its row is kept. A session nobody
    /// sent to is a draft, reachable through the binding alone.
    history_row: bool,
}

fn residue(host: &AgentHost, session_id: &str) -> Residue {
    let acp_id = acp::SessionId::new(session_id);
    let registry = host.sessions.residue(session_id);
    // The turn controller and the seat are one value in the registry now:
    // a controller is there when the value is and holds more than a seat.
    let (turn_control, seat) = host.sessions.extra_mut(session_id, |steering| {
        steering.map_or((false, false), |s| {
            (s.has_control() || !s.has_seat(), s.has_seat())
        })
    });
    let (record, holds) = (registry.bound, registry.holds.len());
    Residue {
        record,
        holds,
        turn_control,
        queued: host.queue_of(session_id).len(),
        seat,
        manager_handle: host.manager().sessions().contains(&acp_id),
        projection: host.projector.snapshot(&acp_id, false, None).is_some(),
        history_row: host
            .history()
            .is_some_and(|history| history.thread_for(&acp_id).is_some()),
    }
}

/// What an agent-wide end leaves: the history binding, which the tab's
/// rebind needs (a draft's row is reachable through nothing else).
const KEPT_FOR_THE_REBIND: Residue = Residue {
    record: false,
    holds: 0,
    turn_control: false,
    queued: 0,
    seat: false,
    manager_handle: false,
    projection: false,
    history_row: true,
};

struct Opened {
    host: Arc<AgentHost>,
    dir: PathBuf,
    agent_id: AgentId,
    key: SessionKey,
    deltas: Arc<Deltas>,
    /// Every id the end observers heard, in order.
    ended: Arc<std::sync::Mutex<Vec<String>>>,
    /// Every id the agent was sent `session/close` for.
    closes: Arc<std::sync::Mutex<Vec<String>>>,
    /// The connection the session runs on, held weakly: whether it can still
    /// be upgraded is whether anything still pins the agent's process.
    connection: std::sync::Weak<dyn AgentConnection>,
    /// Releases one parked turn, when the session was opened holding them.
    turns: Arc<tokio::sync::Notify>,
    _watchdog: Watchdog,
}

impl Opened {
    fn residue(&self) -> Residue {
        residue(&self.host, SESSION)
    }

    fn ended(&self) -> Vec<String> {
        self.ended.lock().unwrap().clone()
    }

    fn closes(&self) -> Vec<String> {
        self.closes.lock().unwrap().clone()
    }

    fn connection_pinned(&self) -> bool {
        self.connection.upgrade().is_some()
    }

    fn done(self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn observed_host(
    advertised: Advertised,
) -> (
    Arc<AgentHost>,
    PathBuf,
    Arc<Deltas>,
    Arc<std::sync::Mutex<Vec<String>>>,
    Watchdog,
) {
    let watchdog = Watchdog::arm();
    let deltas = Arc::new(Deltas::default());
    let (host, dir) = super::super::test_support::fresh_host_with_native_and_sink(
        CapabilityAgent::new(ATLAS_AGENT_ID, SESSION, advertised),
        deltas.clone(),
    );
    let ended: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let heard = ended.clone();
    host.observe_session_end(Arc::new(move |session_id: &str| {
        heard.lock().unwrap().push(session_id.to_string());
    }));
    (host, dir, deltas, ended, watchdog)
}

async fn open_with(hold_turns: bool) -> Opened {
    let closes: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let turns = Arc::new(tokio::sync::Notify::new());
    let (host, dir, deltas, ended, watchdog) = observed_host(Advertised {
        closes: Some(closes.clone()),
        load: true,
        hold_turns: hold_turns.then(|| turns.clone()),
        live_catalogue: Some(ScriptedCatalogue::answering(
            atlas_acp_thread::ModelCatalogueOutcome::ReconnectRequired,
        )),
        ..Advertised::default()
    });
    let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
    tokio::task::yield_now().await;
    let connection = Arc::downgrade(
        &host
            .manager()
            .connected(&Agent::Native)
            .expect("the agent is connected"),
    );
    let init = host
        .new_session(agent_id, dir.clone(), Vec::new())
        .await
        .expect("a session opens");
    assert_eq!(init.key.session_id, SESSION);
    assert_eq!(
        residue(&host, SESSION),
        Residue {
            record: true,
            manager_handle: true,
            projection: true,
            history_row: true,
            ..Residue::default()
        },
        "precondition: an open session is held in all four places"
    );
    Opened {
        host,
        dir,
        agent_id,
        key: init.key,
        deltas,
        ended,
        closes,
        connection,
        turns,
        _watchdog: watchdog,
    }
}

async fn open() -> Opened {
    open_with(false).await
}

async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

// ---- the window lets it go ------------------------------------------------

#[tokio::test]
async fn closing_a_session_ends_it_whole_and_once() {
    let s = open().await;

    s.host.drop_session(SESSION).await.expect("drop");

    assert_eq!(s.residue(), Residue::default());
    assert_eq!(s.ended(), [SESSION]);
    assert_eq!(
        s.closes(),
        [SESSION],
        "the agent is asked to close its side"
    );
    assert!(s.deltas.disconnects().is_empty());
    assert!(
        s.host.manager().connected(&Agent::Native).is_some(),
        "the last session going leaves the connection up"
    );

    s.host.drop_session(SESSION).await.expect("a second drop");
    assert_eq!(s.ended(), [SESSION], "a second end announces nothing");
    assert_eq!(s.closes(), [SESSION]);
    s.done();
}

#[tokio::test]
async fn a_held_session_outlives_its_tab_until_the_last_hold_goes() {
    let s = open().await;
    s.host.hold_session(SESSION, "rc:a").expect("held");
    s.host.hold_session(SESSION, "rc:b").expect("held twice");

    s.host.drop_session(SESSION).await.expect("drop");
    assert_eq!(
        s.residue(),
        Residue {
            record: true,
            holds: 2,
            manager_handle: true,
            projection: true,
            history_row: true,
            ..Residue::default()
        },
        "the tab going changes nothing while a hold is taken"
    );
    assert!(s.ended().is_empty());

    s.host.release_session(SESSION, "rc:a").await.expect("one");
    assert!(s.residue().record, "one hold is left");
    s.host.release_session(SESSION, "rc:b").await.expect("last");

    assert_eq!(s.residue(), Residue::default());
    assert_eq!(s.ended(), [SESSION]);
    assert_eq!(s.closes(), [SESSION]);
    assert_eq!(
        s.deltas.holds(),
        [true, false],
        "the last release is announced before the session goes"
    );

    s.host
        .release_session(SESSION, "rc:b")
        .await
        .expect("again");
    assert_eq!(s.ended(), [SESSION]);
    s.done();
}

#[tokio::test]
async fn a_held_session_the_window_took_back_survives_the_release() {
    let s = open().await;
    s.host.hold_session(SESSION, "rc:a").expect("held");
    s.host.drop_session(SESSION).await.expect("drop");

    // The tab is back: a rebind of a session that is still bound.
    let key = s
        .host
        .load_session(s.agent_id, SESSION.into(), s.dir.clone())
        .await
        .expect("rebind");
    assert_eq!(key, s.key);
    s.host
        .release_session(SESSION, "rc:a")
        .await
        .expect("release");

    assert!(s.residue().record, "the window has it again");
    assert_eq!(s.residue().holds, 0);
    assert!(s.ended().is_empty());
    assert_eq!(s.deltas.holds(), [true, false]);
    s.done();
}

#[tokio::test]
async fn closing_during_a_running_turn_ends_it_and_the_late_turn_brings_nothing_back() {
    let s = open_with(true).await;
    s.host
        .submit(&s.key, Prompt::text("go"), Origin::Local, SubmitPolicy::Now)
        .expect("send");
    until("the turn never started", || {
        s.host.agent_turn_running(ATLAS_AGENT_ID)
    })
    .await;
    assert!(s.residue().turn_control);

    // The session was sent to, so its history row outlives it; nothing else
    // does.
    let only_the_row = Residue {
        history_row: true,
        ..Residue::default()
    };
    s.host.drop_session(SESSION).await.expect("drop");
    assert_eq!(s.residue(), only_the_row);

    // The turn's own task now comes back to a session that is gone.
    s.turns.notify_one();
    until("the turn never returned", || {
        s.host
            .atlas_activity()
            .get(SESSION)
            .is_some_and(|a| a.in_flight == 0)
    })
    .await;
    tokio::task::yield_now().await;
    assert_eq!(s.residue(), only_the_row);
    assert_eq!(s.ended(), [SESSION]);
    s.done();
}

// ---- its agent goes -------------------------------------------------------

#[tokio::test]
async fn killing_an_agent_ends_its_sessions() {
    for by_plugin in [false, true] {
        let s = open().await;
        if by_plugin {
            s.host.kill_plugin(ATLAS_AGENT_ID).expect("kill");
        } else {
            s.host.kill(s.agent_id).expect("kill");
        }

        assert_eq!(
            s.residue(),
            KEPT_FOR_THE_REBIND,
            "the projection goes too: it holds the thread, and the thread the connection"
        );
        assert!(!s.connection_pinned(), "nothing keeps the killed process");
        assert_eq!(s.ended(), [SESSION]);
        assert!(s.closes().is_empty(), "the process is going: no close");
        assert!(s.deltas.disconnects().is_empty(), "a kill sends no notice");
        assert!(s.host.manager().connected(&Agent::Native).is_none());

        s.host.kill_plugin(ATLAS_AGENT_ID).expect("again");
        assert_eq!(s.ended(), [SESSION]);
        s.done();
    }
}

#[tokio::test]
async fn an_update_restart_tells_the_chats_and_releases_the_process() {
    let s = open().await;

    s.host
        .restart_for_update(ATLAS_AGENT_ID, "2.0.0")
        .expect("restart");

    assert_eq!(s.residue(), KEPT_FOR_THE_REBIND);
    assert!(!s.connection_pinned(), "nothing keeps the old process");
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert_eq!(
        s.deltas.disconnects(),
        ["updated to v2.0.0; the next message reconnects"]
    );
    s.done();
}

#[tokio::test]
async fn turning_an_agent_off_tells_the_chats_and_releases_the_process() {
    let s = open().await;

    s.host.turn_off(ATLAS_AGENT_ID).expect("off");

    assert_eq!(s.residue(), KEPT_FOR_THE_REBIND);
    assert!(!s.connection_pinned());
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert_eq!(s.deltas.disconnects(), ["turned off in Settings → Agents"]);
    s.done();
}

#[tokio::test]
async fn an_agent_process_exit_tells_the_chats_and_forgets_the_sessions() {
    let s = open().await;
    // What the manager has done by the time it announces the exit.
    s.host.manager().drop_connection(&Agent::Native);

    s.host.agent_exited(&Agent::Native);

    assert_eq!(s.residue(), KEPT_FOR_THE_REBIND);
    assert!(!s.connection_pinned());
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert_eq!(
        s.deltas.disconnects(),
        ["the agent stopped; the next message reconnects"]
    );

    s.host.agent_exited(&Agent::Native);
    assert_eq!(s.ended(), [SESSION], "a second exit announces nothing");
    s.done();
}

#[tokio::test]
async fn signing_out_ends_the_native_sessions() {
    let s = open().await;

    s.host.drop_native_connection();

    assert_eq!(
        s.residue(),
        KEPT_FOR_THE_REBIND,
        "the projection goes too: it holds the thread, and the thread the connection"
    );
    assert!(!s.connection_pinned(), "nothing keeps the old process");
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert!(s.deltas.disconnects().is_empty());
    s.done();
}

#[tokio::test]
async fn a_model_list_that_needs_a_reconnect_tells_the_chats_and_ends_the_sessions() {
    let s = open().await;

    let refreshed = s
        .host
        .refresh_models(ATLAS_AGENT_ID)
        .await
        .expect("refresh");
    assert!(refreshed.reconnected);

    assert_eq!(
        s.residue(),
        KEPT_FOR_THE_REBIND,
        "the projection goes too: it holds the thread, and the thread the connection"
    );
    assert!(!s.connection_pinned(), "nothing keeps the old process");
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert_eq!(
        s.deltas.disconnects(),
        ["the model list changed; restart to continue"]
    );
    s.done();
}

#[tokio::test]
async fn quitting_ends_every_session_and_releases_every_process() {
    let s = open().await;

    s.host.shutdown();

    assert_eq!(s.residue(), KEPT_FOR_THE_REBIND);
    assert!(!s.connection_pinned());
    assert_eq!(s.ended(), [SESSION]);
    assert!(s.closes().is_empty());
    assert!(s.deltas.disconnects().is_empty());

    s.host.shutdown();
    assert_eq!(s.ended(), [SESSION]);
    s.done();
}

// ---- what survives, and what comes back ------------------------------------

#[tokio::test]
async fn a_parked_queue_outlives_the_agents_process_and_the_rebind_picks_it_up() {
    let s = open().await;
    s.host
        .enqueue(&s.key, Prompt::text("later"), Origin::Local)
        .expect("parked");
    s.host.manager().drop_connection(&Agent::Native);

    s.host.agent_exited(&Agent::Native);
    assert_eq!(
        s.residue(),
        Residue {
            turn_control: true,
            queued: 1,
            ..KEPT_FOR_THE_REBIND
        },
        "the queue is all that is kept"
    );

    // The tab's next send respawns the agent and reloads the session.
    let agent_id = s
        .host
        .spawn(ATLAS_AGENT_ID)
        .await
        .expect("respawn")
        .agent_id;
    s.host
        .load_session(agent_id, SESSION.into(), s.dir.clone())
        .await
        .expect("rebind");
    assert_eq!(
        s.residue(),
        Residue {
            record: true,
            turn_control: true,
            queued: 1,
            manager_handle: true,
            projection: true,
            history_row: true,
            ..Residue::default()
        }
    );
    s.done();
}

#[tokio::test]
async fn an_empty_turn_controller_goes_with_the_agents_process() {
    let s = open().await;
    s.host
        .set_queue_paused(&s.key, true)
        .expect("a controller exists");
    assert!(s.residue().turn_control);

    s.host.kill(s.agent_id).expect("kill");

    assert!(!s.residue().turn_control);
    s.done();
}

#[tokio::test]
async fn a_closed_session_and_its_remote_control_seat() {
    let s = open().await;
    s.host.set_remote_driver(
        SESSION,
        "owner",
        Some(RemoteDriver {
            id: "ada".into(),
            name: Some("Ada".into()),
        }),
    );

    s.host.drop_session(SESSION).await.expect("drop");

    assert_eq!(
        s.residue(),
        Residue {
            seat: true,
            ..Residue::default()
        }
    );
    s.done();
}

#[tokio::test]
async fn an_agent_killed_while_a_session_is_opening_on_it() {
    let opens = Arc::new(tokio::sync::Notify::new());
    let (host, dir, _deltas, ended, _watchdog) = observed_host(Advertised {
        hold_opens: Some(opens.clone()),
        ..Advertised::default()
    });
    let agent_id = host.spawn(ATLAS_AGENT_ID).await.expect("spawn").agent_id;
    let opening = tokio::spawn({
        let (host, dir) = (host.clone(), dir.clone());
        async move { host.new_session(agent_id, dir, Vec::new()).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    host.kill(agent_id).expect("kill");
    opens.notify_one();
    let opened = opening.await.expect("joined");

    assert!(opened.is_ok());
    assert_eq!(
        residue(&host, SESSION),
        Residue {
            record: true,
            manager_handle: true,
            projection: true,
            history_row: true,
            ..Residue::default()
        }
    );
    assert!(ended.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
