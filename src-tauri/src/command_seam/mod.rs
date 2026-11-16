//! Calling a command the way the window does: by name, with a JSON payload,
//! against a real `AppHandle` with managed state, getting JSON and events back.
//!
//! Everything below a command has its own tests. What they cannot see is the
//! seam itself: the name the command is registered under, the argument names
//! serde expects (`expectedGeneration`, not `expected_generation`), the JSON an
//! `Ok` and an `Err` turn into, and the events emitted on the way. Those are
//! opaque strings to `tsc` and to `rustc`; a mismatch compiles on both sides
//! and fails in the shipped app.
//!
//! # How it works
//!
//! [`SeamApp::over`] builds an app on Tauri's mock runtime (`tauri::test`, a
//! dev-only feature) with the directory it is given as its whole home:
//! `app.path()`'s app directories are redirected under it, and `config.toml`
//! is bootstrapped inside it. It panics if any of those would land outside the
//! directory, or if the directory is not under the system temp directory, so a
//! test cannot reach the real profile.
//!
//! [`SeamApp::invoke`] sends one IPC request through `Webview::on_message`,
//! the function the real IPC handler calls, and waits a bounded time for the
//! answer. [`SeamApp::events`] records a channel's payloads.
//!
//! # What it can reach
//!
//! `generate_handler!` is built per runtime, so [`handler`] can list a command
//! only when its signature compiles for the mock runtime: it names no runtime
//! type at all, or it is generic (`AppHandle<R>`). A command that says
//! `AppHandle` means the real runtime's and cannot be listed. To bring one in,
//! make it and what it calls with the handle generic over `R: Runtime`, then
//! add it to [`handler`].
//!
//! Settings effects whose target is not managed here (the telemetry client,
//! the keep-awake manager, instruction sync) are skipped, as
//! `settings_effects::target` says. The process-wide ones are applied for
//! real, which is why a test that commits settings holds [`process_env`].

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, MutexGuard};
use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::utils::config::AppDirectoriesOverride;
use tauri::webview::InvokeRequest;
use tauri::{Listener, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::state::atlas_config::{bootstrap_at, CONFIG_FILE_NAME};
use crate::state::{AppState, AppStateHandle, AtlasConfigHandle};

mod tests;

/// How long one command, or one condition a test waits for, may take. Far
/// longer than any of them needs: reaching it means something hung.
pub(crate) const PATIENCE: Duration = Duration::from_secs(20);

/// The commands a [`SeamApp`] answers. See the module doc for what can be
/// listed here.
fn handler() -> impl Fn(tauri::ipc::Invoke<MockRuntime>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        crate::commands::app_state::bootstrap_app_state,
        crate::commands::app_state::save_app_state,
        crate::commands::atlas_config::get_atlas_config_info,
        crate::commands::atlas_config::update_atlas_settings,
        crate::commands::fs::read_file_content,
        crate::commands::git_ops::git_branches_full,
    ]
}

/// Serialises the tests that change process-wide state: the environment
/// variable and the static that `settings_effects` writes on every committed
/// settings change. Hold the guard for as long as the test reads either.
///
/// The wait is bounded, so a test stuck holding it fails the others instead of
/// hanging them.
pub(crate) fn process_env() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.try_lock_for(PATIENCE * 3)
        .expect("another test held the process-environment lock for too long")
}

/// Poll `ready` until it answers, or panic after [`PATIENCE`]. For what a
/// command finishes after it has replied (`save_app_state` writes on a
/// detached thread).
pub(crate) fn wait_for<T>(what: &str, mut ready: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(value) = ready() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// An app on the mock runtime whose whole home is one temp directory.
pub(crate) struct SeamApp {
    app: tauri::App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    home: PathBuf,
}

/// A command that has been sent and not yet waited for.
pub(crate) struct Pending {
    command: String,
    answer: mpsc::Receiver<InvokeResponse>,
}

/// The payloads one event channel has carried since [`SeamApp::events`].
#[derive(Clone)]
pub(crate) struct Events(Arc<Mutex<Vec<Value>>>);

impl Events {
    pub(crate) fn all(&self) -> Vec<Value> {
        self.0.lock().clone()
    }
}

impl SeamApp {
    /// Start an app whose state lives in `home`. A second app over the same
    /// directory is a restart: it loads what the first one saved.
    pub(crate) fn over(home: &Path) -> Self {
        let home = dunce::canonicalize(home).expect("the test home exists");
        let temp = dunce::canonicalize(std::env::temp_dir()).expect("a temp directory");
        assert!(
            home.starts_with(&temp) && home != temp,
            "{} is not a directory of its own under the temp directory {}",
            home.display(),
            temp.display()
        );

        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = "dev.atlas.command-seam".into();
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(home.join("app")));

        let config_path = home.join("config").join(CONFIG_FILE_NAME);
        let config: AtlasConfigHandle = Arc::new(Mutex::new(bootstrap_at(config_path)));

        let app = mock_builder()
            .invoke_handler(handler())
            .manage(config)
            .build(context)
            .expect("the mock app builds");

        let seam = {
            // `main`, the label the real window has: `settings_effects` looks
            // it up by name.
            let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("the mock window builds");
            SeamApp { app, webview, home }
        };
        seam.assert_contained();

        // As `setup` does: load, then manage.
        let state: AppStateHandle = Arc::new(Mutex::new(AppState::load(seam.app.handle())));
        seam.app.manage(state);
        seam
    }

    /// Every directory this app resolves is inside its home. The mock runtime
    /// resolves app directories like the real one, under the user's profile,
    /// unless they are overridden; this is what notices an override that did
    /// not take.
    fn assert_contained(&self) {
        let paths = self.app.path();
        let resolved = [
            ("app_config_dir", paths.app_config_dir()),
            ("app_data_dir", paths.app_data_dir()),
            ("app_local_data_dir", paths.app_local_data_dir()),
            ("app_cache_dir", paths.app_cache_dir()),
            ("app_log_dir", paths.app_log_dir()),
        ];
        for (name, path) in resolved {
            let path = path.unwrap_or_else(|e| panic!("{name} does not resolve: {e}"));
            assert!(
                path.starts_with(&self.home),
                "{name} resolved to {}, outside the test home {}",
                path.display(),
                self.home.display()
            );
        }
        let config = self.config_path();
        assert!(
            config.starts_with(&self.home),
            "config.toml is at {}, outside the test home {}",
            config.display(),
            self.home.display()
        );
    }

    /// Where this app's `config.toml` is.
    pub(crate) fn config_path(&self) -> PathBuf {
        let handle = self.app.state::<AtlasConfigHandle>();
        let path = handle.lock().path().to_path_buf();
        path
    }

    /// Where this app's `state.json` is.
    pub(crate) fn state_path(&self) -> PathBuf {
        self.home.join("app").join("state.json")
    }

    /// The managed state of type `T`, as a command receives it.
    pub(crate) fn state<T: Clone + Send + Sync + 'static>(&self) -> T {
        self.app.state::<T>().inner().clone()
    }

    /// Record every payload emitted on `channel` from now on. Listeners run
    /// inside `emit`, so what a command emitted before it answered is recorded
    /// by the time [`Self::invoke`] returns.
    pub(crate) fn events(&self, channel: &str) -> Events {
        let events = Events(Arc::default());
        let sink = events.clone();
        self.app.listen_any(channel, move |event| {
            let payload = serde_json::from_str(event.payload())
                .unwrap_or_else(|e| panic!("an event payload is not JSON: {e}"));
            sink.0.lock().push(payload);
        });
        events
    }

    /// Send `command` with `args`, the object `invoke(command, args)` sends,
    /// without waiting for the answer.
    ///
    /// The request is delivered from a thread of its own: a synchronous
    /// command runs inside `on_message`, so delivering it from here would put
    /// its whole run outside the bounded wait.
    pub(crate) fn send(&self, command: &str, args: Value) -> Pending {
        let (tx, answer) = mpsc::sync_channel(1);
        let webview: &tauri::Webview<MockRuntime> = self.webview.as_ref();
        let webview = webview.clone();
        let request = InvokeRequest {
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            // The origin the app's own pages have: what makes the request
            // local, and so allowed to reach an app command.
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("a valid origin"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        std::thread::spawn(move || {
            webview.on_message(
                request,
                Box::new(move |_webview, _command, response, _callback, _error| {
                    let _ = tx.send(response);
                }),
            );
        });
        Pending {
            command: command.to_string(),
            answer,
        }
    }

    /// Send `command` and wait for its answer: `Ok` with what the promise
    /// resolves to, `Err` with what it rejects with.
    pub(crate) fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        self.send(command, args).answer()
    }
}

impl Pending {
    /// The command's answer, or a panic if it has not come within
    /// [`PATIENCE`].
    pub(crate) fn answer(self) -> Result<Value, Value> {
        match self.answer.recv_timeout(PATIENCE) {
            Ok(InvokeResponse::Ok(body)) => Ok(body
                .deserialize::<Value>()
                .unwrap_or_else(|e| panic!("`{}` answered something not JSON: {e}", self.command))),
            Ok(InvokeResponse::Err(error)) => Err(error.0),
            Err(_) => panic!("`{}` did not answer within {PATIENCE:?}", self.command),
        }
    }
}
