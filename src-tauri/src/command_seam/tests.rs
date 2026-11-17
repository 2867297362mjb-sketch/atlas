//! The first commands held at the seam. Each test says what breaks in the
//! shipped app when it fails.

use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{process_env, wait_for, SeamApp};
use crate::state::app_state::fixtures;
use crate::state::AtlasConfigHandle;

/// The variable the engine reads its plugin-catalogue sync gate from. Spelled
/// out here, not imported: the engine reads this name.
const PLUGIN_SYNC_GATE: &str = "ATLAS_CURATED_PLUGIN_SYNC";

/// Puts the process-wide targets of `settings_effects` back when a test that
/// commits settings ends, pass or fail. Take it after [`process_env`], so it
/// is dropped before the lock is released.
struct ProcessWideSettings {
    plugin_sync_gate: Option<String>,
    atlas_only_memory: bool,
}

impl ProcessWideSettings {
    fn remember() -> Self {
        Self {
            plugin_sync_gate: std::env::var(PLUGIN_SYNC_GATE).ok(),
            atlas_only_memory: atlas_agent_servers::atlas_only_memory(),
        }
    }
}

impl Drop for ProcessWideSettings {
    fn drop(&mut self) {
        match &self.plugin_sync_gate {
            Some(value) => std::env::set_var(PLUGIN_SYNC_GATE, value),
            None => std::env::remove_var(PLUGIN_SYNC_GATE),
        }
        atlas_agent_servers::set_atlas_only_memory(self.atlas_only_memory);
    }
}

fn generation_of(app: &SeamApp) -> u64 {
    let info = app
        .invoke("get_atlas_config_info", json!({}))
        .expect("get_atlas_config_info answers");
    info["generation"].as_u64().expect("a generation")
}

fn config_text(app: &SeamApp) -> String {
    std::fs::read_to_string(app.config_path()).expect("config.toml is on disk")
}

// If this fails: a toggle in Settings is not saved, the window's copy of the
// settings goes stale (its next edit is refused as a conflict), or the setting
// is saved and does nothing until restart.
#[test]
fn a_settings_patch_is_written_announced_and_applied() {
    let _env = process_env();
    let _restore = ProcessWideSettings::remember();
    let home = tempfile::tempdir().unwrap();
    let app = SeamApp::over(home.path());
    let announced = app.events("atlas:config-changed");
    let generation = generation_of(&app);
    assert!(!config_text(&app).contains("curatedPluginSync = true"));

    let answer = app
        .invoke(
            "update_atlas_settings",
            json!({ "patch": { "curatedPluginSync": true }, "expectedGeneration": generation }),
        )
        .expect("the patch is accepted");

    assert_eq!(answer["kind"], "applied", "{answer}");
    assert_eq!(answer["settings"]["curatedPluginSync"], true);
    let new_generation = answer["generation"].as_u64().expect("a generation");
    assert!(new_generation > generation);
    assert!(config_text(&app).contains("curatedPluginSync = true"));
    assert_eq!(
        announced.all(),
        vec![json!({ "settings": answer["settings"], "generation": new_generation })],
        "the window hears the new snapshot once, with its generation"
    );
    assert_eq!(std::env::var(PLUGIN_SYNC_GATE).as_deref(), Ok("1"));

    // Switched back off, the gate goes with it: the effect follows the value.
    let answer = app
        .invoke(
            "update_atlas_settings",
            json!({ "patch": { "curatedPluginSync": false }, "expectedGeneration": new_generation }),
        )
        .expect("the patch is accepted");
    assert_eq!(answer["kind"], "applied", "{answer}");
    assert!(std::env::var(PLUGIN_SYNC_GATE).is_err());
    assert_eq!(announced.all().len(), 2);
}

// If this fails: a Settings edit made from a stale snapshot overwrites what
// was hand-edited into config.toml in the meantime, with no warning.
#[test]
fn a_patch_from_a_stale_generation_is_refused_and_writes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let app = SeamApp::over(home.path());
    let announced = app.events("atlas:config-changed");
    let generation = generation_of(&app);
    let before = config_text(&app);

    let answer = app
        .invoke(
            "update_atlas_settings",
            json!({ "patch": { "showTips": false }, "expectedGeneration": generation + 1 }),
        )
        .expect("a conflict is an answer, not an error");

    assert_eq!(answer["kind"], "conflict", "{answer}");
    assert_eq!(
        answer["generation"], generation,
        "the generation to retry from"
    );
    assert_eq!(answer["settings"]["showTips"], true, "what is on disk now");
    assert_eq!(config_text(&app), before);
    assert_eq!(announced.all(), Vec::<Value>::new());
}

// If this fails: the projects and organisations in the sidebar are gone, or
// changed, the next time Atlas starts.
#[test]
fn a_saved_state_is_what_the_next_launch_bootstraps_with() {
    let home = tempfile::tempdir().unwrap();
    let saved = serde_json::to_value(fixtures::patch_of(&fixtures::full_state())).unwrap();
    let state_path = {
        let app = SeamApp::over(home.path());
        let answer = app.invoke("save_app_state", json!({ "payload": saved }));
        assert_eq!(answer, Ok(Value::Null));
        app.state_path()
    };
    // The command answers before the write lands (it is on its own thread).
    wait_for("state.json to hold the saved projects", || {
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&state_path).ok()?).ok()?;
        (on_disk["workspaces"] == saved["workspaces"]).then_some(())
    });

    let relaunched = SeamApp::over(home.path());
    let boot = relaunched
        .invoke("bootstrap_app_state", json!({}))
        .expect("bootstrap answers");

    for key in [
        "recentProjects",
        "workspaces",
        "activeWorkspaceId",
        "organisations",
        "activeOrganisationId",
    ] {
        assert!(!saved[key].is_null(), "the fixture fills `{key}`");
        assert_eq!(boot[key], saved[key], "`{key}` after a restart");
    }
    // The settings ride in the same answer, beside the state and not inside it.
    assert!(boot["settings"].is_object(), "{boot}");
    assert_eq!(boot["configGeneration"], generation_of(&relaunched));
    assert_eq!(boot["configStatus"], json!({ "status": "ok" }));
}

// If this fails: the editor's size cap is dropped without an error (an
// unknown argument name is ignored, so `maxBytes` would read as "no cap"), and
// opening a huge log loads all of it into the window.
#[test]
fn the_read_cap_arrives_under_the_name_the_editor_sends() {
    let home = tempfile::tempdir().unwrap();
    let app = SeamApp::over(home.path());
    let file = home.path().join("notes.txt");
    std::fs::write(&file, "ten bytes!").unwrap();

    let capped = app.invoke("read_file_content", json!({ "path": file, "maxBytes": 4 }));
    // The editor matches this prefix and reads the size after it.
    assert_eq!(capped, Err(json!("file-too-large:10")));

    let within = app.invoke("read_file_content", json!({ "path": file, "maxBytes": 10 }));
    assert_eq!(within, Ok(json!("ten bytes!")));

    // The Rust spelling is not the wire spelling: sent like this, the cap is
    // ignored. This is the silent half the first assertion guards.
    let misnamed = app.invoke("read_file_content", json!({ "path": file, "max_bytes": 4 }));
    assert_eq!(misnamed, Ok(json!("ten bytes!")));
}

// If this fails: a failed git action shows a raw object or nothing where the
// friendly message and its "Fix with agent" context should be, because the
// window recognises a git error by these fields.
#[test]
fn a_git_failure_rejects_with_the_payload_the_window_reads() {
    let home = tempfile::tempdir().unwrap();
    let app = SeamApp::over(home.path());
    let not_a_repo = home.path().join("plain-folder");
    std::fs::create_dir(&not_a_repo).unwrap();

    let error = app
        .invoke("git_branches_full", json!({ "path": not_a_repo }))
        .expect_err("a folder that is not a repository has no branches");

    assert_eq!(error["code"], "not-a-repository", "{error}");
    assert_eq!(error["message"], "This folder is not a git repository.");
    assert!(error["rawStderr"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(error["command"]
        .as_str()
        .is_some_and(|s| s.starts_with("git ")));
    assert!(error["exitCode"].is_i64(), "{error}");
    // Empty extras are left out, not sent as `[]` and `null`.
    assert!(error.get("files").is_none() && error.get("hint").is_none());
}

// If this fails: while a settings write waits (on the config lock, on a slow
// disk), the async runtime's workers wait with it, and every other command
// and event in the window stalls until it is through.
#[test]
fn a_settings_write_waits_off_the_async_runtime() {
    let _env = process_env();
    let _restore = ProcessWideSettings::remember();
    let home = tempfile::tempdir().unwrap();
    let app = SeamApp::over(home.path());
    let generation = generation_of(&app);
    let config = app.state::<AtlasConfigHandle>();

    // Hold the lock every write needs, then send more writes than the runtime
    // has workers. Were the lock taken on a worker, they would all be stuck.
    let held = config.lock();
    let workers = std::thread::available_parallelism().map_or(8, usize::from);
    let writes: Vec<_> = (0..workers * 2)
        .map(|_| {
            app.send(
                "update_atlas_settings",
                json!({ "patch": { "showTips": false }, "expectedGeneration": generation }),
            )
        })
        .collect();
    // Time for each write to reach the lock. Only a broken command needs it:
    // one that waits on a blocking thread leaves the workers free at once.
    std::thread::sleep(Duration::from_millis(300));

    let (tx, rx) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = tx.send(());
    });
    let runtime_is_free = rx.recv_timeout(Duration::from_secs(5)).is_ok();
    drop(held);
    assert!(
        runtime_is_free,
        "{} settings writes waiting on the config lock stalled the async runtime",
        writes.len()
    );

    // And once the lock is free every one of them answers: one wins, the
    // rest are told the generation moved.
    let kinds: Vec<String> = writes
        .into_iter()
        .map(|write| {
            let answer = write.answer().expect("a write answers");
            answer["kind"].as_str().expect("a kind").to_string()
        })
        .collect();
    assert_eq!(kinds.iter().filter(|kind| *kind == "applied").count(), 1);
    assert!(kinds
        .iter()
        .all(|kind| kind == "applied" || kind == "conflict"));
}
