//! Settings that do something beyond being read.
//!
//! Most settings are read where they are used. A few have a live side effect:
//! a flag cached in another subsystem, a process environment variable, the
//! window's colour. Those have to be applied when Atlas starts and again
//! whenever the settings change, and this module says which settings they are.
//!
//! This is the only place that says so: [`WIRING`] lists each one once, and
//! [`apply`] walks that list on both paths. A setting added to the list is
//! applied at boot and on every change; there is no second site to forget.
//!
//! [`effects`] is the pure half: what a settings snapshot asks for on each
//! path. It needs no app, so the tests below read it directly. `perform` is
//! the half that reaches into the app.
//!
//! # Where boot differs from a change
//!
//! - **Nothing is listening at boot.** `atlas:config-changed` is emitted on a
//!   change only: the webview has not loaded, and it reads the settings it
//!   starts with from `bootstrap_app_state`.
//! - **The targets must be managed first.** `setup` manages the telemetry
//!   client and the keep-awake manager, both switched off, immediately before
//!   it calls [`apply`]; neither takes the setting as a constructor argument
//!   any more, so this module is the only thing that switches them on.
//! - **The telemetry gate is set silently at boot.** On a change it goes
//!   through `set_enabled`, which records `telemetry_opt_in` or
//!   `telemetry_opt_out`. A launch is not a change of mind, so boot uses
//!   `init_enabled`, which records nothing.
//! - **Before the first agent connect.** The engine reads the plugin sync
//!   gate from the environment on its first connect. That happens after
//!   `setup` returns, so applying at boot from inside `setup` is early enough.
//! - **Effects listed for one path only** carry their reason in [`WIRING`].

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::atlas_config::ThemeMode;
use crate::state::AppSettings;

/// Which of the two moments a settings snapshot is being applied at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum When {
    /// Atlas is starting: `setup` in `lib.rs`, before the webview loads.
    Boot,
    /// A new snapshot was committed while Atlas runs: a Settings UI patch,
    /// "Recreate defaults", a hot reload of an edited `config.toml`, or a
    /// Rust-side write. `generation` is the snapshot's.
    Changed { generation: u64 },
}

/// One live side effect of a setting, with the value it should take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// `shareTelemetry`: the telemetry client's consent gate, a cached flag.
    TelemetryGate(bool),
    /// `linkTelemetryToAccount`: whether events carry the signed-in account.
    TelemetryIdentity { link_to_account: bool },
    /// `curatedPluginSync`: the engine's plugin-catalogue sync gate, carried
    /// as process environment.
    CuratedPluginSync(bool),
    /// `themeLight`, `themeDark`, `themeMode`: the native window background.
    WindowBackground {
        light: String,
        dark: String,
        mode: ThemeMode,
    },
    /// `appIcon`: the Dock and Finder icon.
    AppIcon(String),
    /// `instructionSync`: mirroring instructions into each project.
    InstructionSync(bool),
    /// `atlasOnlyMemory`: whether agents start with their own memory off.
    AtlasOnlyMemory(bool),
    /// `keepAwakeWhileRunning`: the power assertion while a session runs.
    KeepAwake(bool),
}

/// Which paths an effect is applied on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Paths {
    /// At boot and on every change: what an effect is unless it has a reason.
    Both,
    /// On a change only, and why boot does not need it.
    ChangeOnly(&'static str),
}

/// One row of [`WIRING`]: the effect a settings snapshot asks for, and the
/// paths it is applied on.
struct Wiring {
    decide: fn(&AppSettings) -> Effect,
    paths: Paths,
}

/// Every setting with a live side effect. Add a row here and nowhere else.
const WIRING: &[Wiring] = &[
    Wiring {
        decide: |s| Effect::TelemetryGate(s.share_telemetry),
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::TelemetryIdentity {
            link_to_account: s.link_telemetry_to_account,
        },
        paths: Paths::ChangeOnly(
            "every auth transition, the launch restore included, reads the setting itself \
             (`commands::auth::broadcast`), so only a change with no transition needs this",
        ),
    },
    Wiring {
        decide: |s| Effect::CuratedPluginSync(s.curated_plugin_sync),
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::WindowBackground {
            light: s.theme_light.clone(),
            dark: s.theme_dark.clone(),
            mode: s.theme_mode,
        },
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::AppIcon(s.app_icon.clone()),
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::InstructionSync(s.instruction_sync),
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::AtlasOnlyMemory(s.atlas_only_memory),
        paths: Paths::Both,
    },
    Wiring {
        decide: |s| Effect::KeepAwake(s.keep_awake_while_running),
        paths: Paths::Both,
    },
];

/// What `settings` asks for at `when`.
pub fn effects(settings: &AppSettings, when: When) -> Vec<Effect> {
    WIRING
        .iter()
        .filter(|wiring| match (wiring.paths, when) {
            (Paths::Both, _) | (Paths::ChangeOnly(_), When::Changed { .. }) => true,
            (Paths::ChangeOnly(_), When::Boot) => false,
        })
        .map(|wiring| (wiring.decide)(settings))
        .collect()
}

/// Apply every settings effect for `settings`.
///
/// Called once from `setup` with [`When::Boot`], and by every committer of a
/// new settings snapshot with [`When::Changed`] — whichever path produced it
/// (a UI patch, `reset`, a hot reload, or a Rust-side write from
/// `commands::models`/`commands::updater` via `state::atlas_config::update`).
///
/// On a change it first tells the frontend (`atlas:config-changed`), so its
/// mirrored `settings`/`configGeneration` never goes stale: a stale generation
/// there is exactly what turns its next legitimate edit into a spurious
/// `Conflict`.
pub fn apply<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings, when: When) {
    if let When::Changed { generation } = when {
        let _ = app.emit(
            "atlas:config-changed",
            serde_json::json!({ "settings": settings, "generation": generation }),
        );
    }
    for effect in effects(settings, when) {
        perform(app, effect, when);
    }
}

fn perform<R: Runtime>(app: &AppHandle<R>, effect: Effect, when: When) {
    if effect.apply_process_wide() {
        return;
    }
    match effect {
        // `TelemetryClient::enabled` is a cached flag, not read fresh from
        // settings per event; without this, a `shareTelemetry` change that
        // didn't come from the Settings UI's own toggle handler (an external
        // edit, the self-configure skill, "Recreate defaults") would leave
        // telemetry emitting — or silently gated off — out of sync with what
        // the file says until restart.
        Effect::TelemetryGate(on) => {
            if let Some(client) = target::<Arc<crate::telemetry::TelemetryClient>, R>(app) {
                match when {
                    When::Boot => client.init_enabled(on),
                    When::Changed { .. } => client.set_enabled(on),
                }
            }
        }
        // Without this, turning account linkage off while signed in left
        // PostHog attributing events to the account until the next sign-out,
        // which is the opposite of what the toggle says.
        Effect::TelemetryIdentity { link_to_account } => {
            crate::commands::auth::resync_telemetry_identity(app, link_to_account);
        }
        // At boot it fills the gap between window-shown and first paint with
        // the theme's own background; see `window_background`. On a change it
        // keeps that colour the current theme's, because the window shows
        // through again wherever the webview has not painted yet: the strip a
        // live resize uncovers, and the frame after a reload.
        Effect::WindowBackground { light, dark, mode } => {
            if let Some(window) = app.get_webview_window("main") {
                let system_is_light = matches!(window.theme(), Ok(tauri::Theme::Light));
                let color = crate::window_background::window_background(
                    &light,
                    &dark,
                    mode,
                    system_is_light,
                );
                let _ = window.set_background_color(Some(color));
            }
        }
        // At boot, before the window shows; on a change, so an external edit
        // of `appIcon` takes effect live like the Settings picker does. A
        // no-op unless it changed.
        Effect::AppIcon(id) => crate::app_icon::apply(app, &id),
        // Switched on, sync and watch each window's active project; switched
        // off, stop watching and take the mirrored block back out. A no-op
        // unless it changed, and at boot there is no active project yet.
        Effect::InstructionSync(on) => {
            if let Some(state) =
                target::<crate::commands::instruction_sync::InstructionSyncState, R>(app)
            {
                state.apply_setting(app, on);
            }
        }
        Effect::KeepAwake(on) => {
            if let Some(keep_awake) = target::<Arc<crate::keep_awake::KeepAwakeManager>, R>(app) {
                keep_awake.set_enabled(on);
            }
        }
        // Process-wide: applied above.
        Effect::CuratedPluginSync(_) | Effect::AtlasOnlyMemory(_) => {}
    }
}

/// The managed state an effect acts on. A missing one means the effect was
/// skipped, which nothing else would report: `setup` has to manage every
/// target before it calls [`apply`].
fn target<T: Send + Sync + 'static, R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, T>> {
    let state = app.try_state::<T>();
    if state.is_none() {
        tracing::error!(
            target: "atlas::config",
            "settings effect skipped: {} is not managed",
            std::any::type_name::<T>()
        );
    }
    state
}

impl Effect {
    /// Apply this effect if its target is process-wide and so needs no app:
    /// an environment variable, a static. Returns whether it was one.
    pub fn apply_process_wide(&self) -> bool {
        match self {
            Effect::CuratedPluginSync(on) => set_curated_plugin_sync_gate(*on),
            Effect::AtlasOnlyMemory(on) => atlas_agent_servers::set_atlas_only_memory(*on),
            _ => return false,
        }
        true
    }
}

/// The variable the engine's curated-plugin sync
/// (`atlas-engine-core-plugins`, `start_curated_repo_sync`) is gated on: a
/// `git fetch` of github.com/openai/plugins at every launch, opt-in from
/// Atlas via `curatedPluginSync`. The engine runs in this process and reads
/// the variable itself when the sync would start (its first connect), so the
/// setting is carried as process environment rather than threaded through the
/// engine's config, and has to be current before that connect.
const CURATED_PLUGIN_SYNC_VAR: &str = "ATLAS_CURATED_PLUGIN_SYNC";

fn set_curated_plugin_sync_gate(enabled: bool) {
    if enabled {
        std::env::set_var(CURATED_PLUGIN_SYNC_VAR, "1");
    } else {
        std::env::remove_var(CURATED_PLUGIN_SYNC_VAR);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOOT: When = When::Boot;
    const CHANGED: When = When::Changed { generation: 7 };

    /// Whether `settings` asks for `effect` at `when`.
    fn asks(settings: &AppSettings, when: When, effect: &Effect) -> bool {
        effects(settings, when).contains(effect)
    }

    /// `effect` is asked for at boot and on a change, for `settings` and not
    /// for the defaults: the value follows the setting on both paths.
    fn on_both_paths(settings: &AppSettings, effect: &Effect) {
        let defaults = AppSettings::default();
        for when in [BOOT, CHANGED] {
            assert!(asks(settings, when, effect), "{effect:?} at {when:?}");
            assert!(
                !asks(&defaults, when, effect),
                "{effect:?} at {when:?} does not come from the setting"
            );
        }
    }

    #[test]
    fn share_telemetry_sets_the_telemetry_gate() {
        let mut settings = AppSettings::default();
        settings.share_telemetry = !settings.share_telemetry;
        on_both_paths(&settings, &Effect::TelemetryGate(settings.share_telemetry));
    }

    #[test]
    fn curated_plugin_sync_sets_the_engine_gate() {
        let mut settings = AppSettings::default();
        settings.curated_plugin_sync = !settings.curated_plugin_sync;
        on_both_paths(
            &settings,
            &Effect::CuratedPluginSync(settings.curated_plugin_sync),
        );
    }

    #[test]
    fn app_icon_sets_the_icon() {
        let settings = AppSettings {
            app_icon: "some-other-icon".into(),
            ..AppSettings::default()
        };
        on_both_paths(&settings, &Effect::AppIcon("some-other-icon".into()));
    }

    #[test]
    fn instruction_sync_follows_the_setting() {
        let mut settings = AppSettings::default();
        settings.instruction_sync = !settings.instruction_sync;
        on_both_paths(
            &settings,
            &Effect::InstructionSync(settings.instruction_sync),
        );
    }

    #[test]
    fn atlas_only_memory_follows_the_setting() {
        let mut settings = AppSettings::default();
        settings.atlas_only_memory = !settings.atlas_only_memory;
        on_both_paths(
            &settings,
            &Effect::AtlasOnlyMemory(settings.atlas_only_memory),
        );
    }

    #[test]
    fn keep_awake_follows_the_setting() {
        let mut settings = AppSettings::default();
        settings.keep_awake_while_running = !settings.keep_awake_while_running;
        on_both_paths(
            &settings,
            &Effect::KeepAwake(settings.keep_awake_while_running),
        );
    }

    #[test]
    fn the_theme_sets_the_window_background() {
        let settings = AppSettings {
            theme_light: "a-light-theme".into(),
            theme_dark: "a-dark-theme".into(),
            theme_mode: ThemeMode::Light,
            ..AppSettings::default()
        };
        let effect = Effect::WindowBackground {
            light: "a-light-theme".into(),
            dark: "a-dark-theme".into(),
            mode: ThemeMode::Light,
        };
        on_both_paths(&settings, &effect);
    }

    /// A change re-applies account linkage. Boot does not need to: every auth
    /// transition, the launch restore included, reads the setting itself
    /// (`commands::auth::broadcast`).
    #[test]
    fn link_telemetry_to_account_is_reapplied_on_a_change() {
        let mut settings = AppSettings::default();
        settings.link_telemetry_to_account = !settings.link_telemetry_to_account;
        let effect = Effect::TelemetryIdentity {
            link_to_account: settings.link_telemetry_to_account,
        };
        assert!(asks(&settings, CHANGED, &effect));
        assert!(!asks(&AppSettings::default(), CHANGED, &effect));
        assert!(!effects(&settings, BOOT)
            .iter()
            .any(|e| matches!(e, Effect::TelemetryIdentity { .. })));
    }

    /// The guard this module exists for: an effect applied on one path only.
    ///
    /// Both paths walk [`WIRING`], so a row is on both unless it says
    /// otherwise, and the rows that say otherwise are named here. Wiring a new
    /// effect to boot only or to a change only fails this test until the
    /// effect is added to the list below, with the reason on its row.
    #[test]
    fn an_effect_on_one_path_only_is_a_named_exception() {
        let settings = AppSettings::default();
        let one_path_only: Vec<Effect> = WIRING
            .iter()
            .filter(|wiring| wiring.paths != Paths::Both)
            .map(|wiring| (wiring.decide)(&settings))
            .collect();
        assert_eq!(
            one_path_only,
            vec![Effect::TelemetryIdentity {
                link_to_account: settings.link_telemetry_to_account,
            }],
            "an effect is applied at boot only or on a change only"
        );
        for wiring in WIRING {
            if let Paths::ChangeOnly(why) = wiring.paths {
                assert!(why.len() >= 20, "a one-path effect states its reason");
            }
        }

        // And the two paths agree on everything else: same effects, same
        // order, same values.
        let boot = effects(&settings, BOOT);
        let changed: Vec<Effect> = effects(&settings, CHANGED)
            .into_iter()
            .filter(|effect| !one_path_only.contains(effect))
            .collect();
        assert_eq!(boot, changed);
    }

    /// Every [`Effect`] has a row in [`WIRING`]. The `match` has no wildcard,
    /// so a new variant does not compile until it is given a slot here, and
    /// then fails until it has a row.
    #[test]
    fn every_effect_is_wired() {
        fn slot(effect: &Effect) -> usize {
            match effect {
                Effect::TelemetryGate(_) => 0,
                Effect::TelemetryIdentity { .. } => 1,
                Effect::CuratedPluginSync(_) => 2,
                Effect::WindowBackground { .. } => 3,
                Effect::AppIcon(_) => 4,
                Effect::InstructionSync(_) => 5,
                Effect::AtlasOnlyMemory(_) => 6,
                Effect::KeepAwake(_) => 7,
            }
        }
        const SLOTS: usize = 8;
        let settings = AppSettings::default();
        let mut rows = [0usize; SLOTS];
        for wiring in WIRING {
            rows[slot(&(wiring.decide)(&settings))] += 1;
        }
        assert_eq!(rows, [1; SLOTS], "each effect has exactly one row");
    }

    /// The two effects whose target is process-wide, observed for real: the
    /// environment variable the engine reads, and the flag an agent launch
    /// reads. One test, because both targets are shared by the whole test
    /// process; each is put back afterwards. The command-seam tests commit
    /// settings through a real app and so write both too: the lock keeps the
    /// two apart.
    #[test]
    fn process_wide_effects_reach_their_targets_on_both_paths() {
        let _env = crate::command_seam::process_env();
        let gate = || std::env::var(CURATED_PLUGIN_SYNC_VAR).ok();
        let gate_before = gate();
        let memory_before = atlas_agent_servers::atlas_only_memory();

        for when in [BOOT, CHANGED] {
            for on in [true, false, true] {
                let settings = AppSettings {
                    curated_plugin_sync: on,
                    atlas_only_memory: !on,
                    ..AppSettings::default()
                };
                let applied = effects(&settings, when)
                    .iter()
                    .filter(|effect| effect.apply_process_wide())
                    .count();
                assert_eq!(applied, 2, "at {when:?}");
                assert_eq!(gate().as_deref(), on.then_some("1"), "at {when:?}");
                assert_eq!(atlas_agent_servers::atlas_only_memory(), !on);
            }
        }

        set_curated_plugin_sync_gate(gate_before.is_some());
        atlas_agent_servers::set_atlas_only_memory(memory_before);
    }
}
