//! Settings that do something beyond being read.
//!
//! Most settings are read where they are used. A few have a live side effect:
//! a flag cached in another subsystem, a process environment variable, the
//! window's colour. Those have to be applied when Atlas starts and again
//! whenever the settings change, and this module says which settings they are.
//!
//! [`effects`] is the pure half: what a settings snapshot asks for on each
//! path. It needs no app, so the tests below read it directly.

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

/// What `settings` asks for at `when`.
pub fn effects(settings: &AppSettings, when: When) -> Vec<Effect> {
    match when {
        When::Boot => vec![
            Effect::TelemetryGate(settings.share_telemetry),
            Effect::CuratedPluginSync(settings.curated_plugin_sync),
            Effect::WindowBackground {
                light: settings.theme_light.clone(),
                dark: settings.theme_dark.clone(),
                mode: settings.theme_mode,
            },
            Effect::AppIcon(settings.app_icon.clone()),
            Effect::InstructionSync(settings.instruction_sync),
            Effect::AtlasOnlyMemory(settings.atlas_only_memory),
            Effect::KeepAwake(settings.keep_awake_while_running),
        ],
        When::Changed { .. } => vec![
            Effect::TelemetryGate(settings.share_telemetry),
            Effect::TelemetryIdentity {
                link_to_account: settings.link_telemetry_to_account,
            },
            Effect::CuratedPluginSync(settings.curated_plugin_sync),
            Effect::AppIcon(settings.app_icon.clone()),
            Effect::InstructionSync(settings.instruction_sync),
            Effect::AtlasOnlyMemory(settings.atlas_only_memory),
            Effect::KeepAwake(settings.keep_awake_while_running),
        ],
    }
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
    fn the_theme_sets_the_window_background_at_boot() {
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
        assert!(asks(&settings, BOOT, &effect));
        assert!(!asks(&AppSettings::default(), BOOT, &effect));
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

    /// The two effects whose target is process-wide, observed for real: the
    /// environment variable the engine reads, and the flag an agent launch
    /// reads. One test, because both targets are shared by the whole test
    /// process; each is put back afterwards.
    #[test]
    fn process_wide_effects_reach_their_targets_on_both_paths() {
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
