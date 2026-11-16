//! The tool registry: which agents exist, where each one reads skills and the
//! other component kinds, and whether it is installed under a root.

use crate::model::ComponentKind;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

// ── Tool registry (CP.2) ─────────────────────────────────────────────────────────

/// How a non-skill component is materialized at its tool home.
///
/// - `Dir`  — placed as a file/dir leaf under a directory home (e.g. an agent
///   file in `.claude/agents/`). This is the projection path skills already use.
/// - `SettingsMerge` — merged into a JSON settings file (Claude Code hooks →
///   `.claude/settings.json`). Phase 3 owns the merge semantics.
/// - `AppendFile` — appended to a flat text file (Codex rules → `AGENTS.md`).
///
/// Phase 0 only records these; the projection engine still handles skills only.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HomeStyle {
    Dir,
    SettingsMerge,
    AppendFile,
}

/// Which scopes a component home applies to.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HomeScope {
    Global,
    Project,
    Both,
}

impl HomeScope {
    /// Does this home apply to the requested `"global"` / `"project"` scope?
    #[allow(dead_code)]
    fn covers(self, scope: &str) -> bool {
        matches!(
            (self, scope),
            (HomeScope::Both, _) | (HomeScope::Global, "global") | (HomeScope::Project, "project")
        )
    }
}

/// Where a single component *kind* lives for a tool, relative to `<root>`
/// (home dir at global scope, project path at project scope).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct ComponentHome {
    pub(crate) kind: ComponentKind,
    pub(crate) scope: HomeScope,
    /// Path relative to root, e.g. `.claude/agents` (Dir) or `.claude/settings.json`
    /// (SettingsMerge) or `AGENTS.md` (AppendFile).
    pub(crate) rel: &'static str,
    pub(crate) style: HomeStyle,
}

/// A statically-known *tool* (agent) and where its skills/config live, relative
/// to `<root>`. Extends the old `AgentDef`: the single `skills_dir` is split into
/// `global_skills_dir` + `project_skills_dir` because Codex uses different paths
/// per scope (`~/.codex/skills` global, `<proj>/.agents/skills` project).
///
/// `homes` lists where the **non-skill** component kinds (agent/command/hook/rule)
/// land for this tool. Skills are intentionally absent — they keep using
/// [`tool_skills_dir`]. A kind with no `homes` row is unsupported by that tool
/// (e.g. Codex has no agents).
pub(crate) struct ToolDef {
    /// Stable key, e.g. `"codex"`.
    pub(crate) id: &'static str,
    pub(crate) display_name: &'static str,
    /// Skills dir relative to home for **global** scope (e.g. `.codex/skills`).
    pub(crate) global_skills_dir: &'static str,
    /// Skills dir relative to the project for **project** scope (e.g. `.agents/skills`).
    pub(crate) project_skills_dir: &'static str,
    /// Config dir relative to root whose existence == "detected".
    pub(crate) config_dir: &'static str,
    /// `false` ⇒ copy-only projection (never attempt a symlink).
    pub(crate) supports_symlink: bool,
    /// `"native-dir"` | `"copy-only"` | `"inject-only"`.
    pub(crate) delivery: &'static str,
    /// Env var that, when set, relocates this tool's **global** skills base to
    /// `$ENV/skills` (e.g. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`).
    pub(crate) env_override: Option<&'static str>,
    /// Where each non-skill component kind lands for this tool. Empty ⇒ this tool
    /// only supports skills (the legacy behavior).
    pub(crate) homes: &'static [ComponentHome],
}

/// `.atlas/agent-skills`, relative to a root — `.atlas-dev/agent-skills` under
/// the dev profile, so a source build's skill toggles never project into the
/// released app's directory. Built once: the registry below holds `&'static`
/// paths.
fn atlas_agent_skills_dir() -> &'static str {
    static DIR: LazyLock<String> =
        LazyLock::new(|| format!("{}/agent-skills", atlas_profile::dir_name()));
    &DIR
}

// v1 in-scope tools: Claude Code + Codex. The registry is trivially extensible —
// a future ACP agent is one more ToolDef row. A `LazyLock` rather than a
// `const` only because the Atlas row's paths come from the profile.
pub(crate) static TOOL_REGISTRY: LazyLock<[ToolDef; 3]> = LazyLock::new(|| {
    [
        ToolDef {
            id: "claude-code",
            display_name: "Claude Code",
            global_skills_dir: ".claude/skills",
            project_skills_dir: ".claude/skills",
            config_dir: ".claude",
            supports_symlink: true,
            delivery: "native-dir",
            env_override: Some("CLAUDE_CONFIG_DIR"),
            // Claude Code is the full-fidelity target: dir homes for agents/commands/
            // rules, and a settings.json merge for hooks. Same paths at both scopes.
            homes: &[
                ComponentHome {
                    kind: ComponentKind::Agent,
                    scope: HomeScope::Both,
                    rel: ".claude/agents",
                    style: HomeStyle::Dir,
                },
                ComponentHome {
                    kind: ComponentKind::Command,
                    scope: HomeScope::Both,
                    rel: ".claude/commands",
                    style: HomeStyle::Dir,
                },
                ComponentHome {
                    kind: ComponentKind::Rule,
                    scope: HomeScope::Both,
                    rel: ".claude/rules",
                    style: HomeStyle::Dir,
                },
                ComponentHome {
                    kind: ComponentKind::Hook,
                    scope: HomeScope::Both,
                    rel: ".claude/settings.json",
                    style: HomeStyle::SettingsMerge,
                },
            ],
        },
        ToolDef {
            id: "codex",
            // Codex: ~/.codex/skills globally, <proj>/.agents/skills at project scope.
            display_name: "Codex",
            global_skills_dir: ".codex/skills",
            project_skills_dir: ".agents/skills",
            config_dir: ".codex",
            supports_symlink: true,
            delivery: "native-dir",
            env_override: Some("CODEX_HOME"),
            // Codex supports a subset: prompt-style commands (global only) and rules
            // appended to AGENTS.md. No agents/hooks. Phase 3 refines the semantics.
            homes: &[
                ComponentHome {
                    kind: ComponentKind::Command,
                    scope: HomeScope::Global,
                    rel: ".codex/prompts",
                    style: HomeStyle::Dir,
                },
                ComponentHome {
                    kind: ComponentKind::Rule,
                    scope: HomeScope::Both,
                    rel: "AGENTS.md",
                    style: HomeStyle::AppendFile,
                },
            ],
        },
        ToolDef {
            id: ATLAS_TOOL_ID,
            display_name: "Atlas",
            // The native in-process "Atlas" agent. Enabled skills are
            // symlinked into a DEDICATED dir that only the in-process `AtlasSkillTool`
            // reads — kept separate from `.agents/skills` (the canonical store) so this
            // toggle is the exclusive gate (no `~/.claude`/bundled-skill leakage). Same
            // path at both scopes (`~/.atlas/agent-skills`, `<root>/.atlas/agent-skills`).
            global_skills_dir: atlas_agent_skills_dir(),
            project_skills_dir: atlas_agent_skills_dir(),
            config_dir: atlas_profile::dir_name(),
            supports_symlink: true,
            delivery: "native-dir",
            env_override: None,
            // The native agent only consumes skills — no agent/command/rule/hook homes.
            homes: &[],
        },
    ]
});

pub(crate) fn tool_def(id: &str) -> Option<&'static ToolDef> {
    TOOL_REGISTRY.iter().find(|t| t.id == id)
}

/// Resolve where a non-skill component `kind` lands for `tool` at `scope`
/// (`"global"` / `"project"`). `None` ⇒ this tool does not support that kind at
/// that scope. Skills are not represented here — use [`tool_skills_dir`].
#[allow(dead_code)]
pub(crate) fn tool_home(
    tool: &ToolDef,
    kind: ComponentKind,
    scope: &str,
) -> Option<&'static ComponentHome> {
    tool.homes
        .iter()
        .find(|h| h.kind == kind && h.scope.covers(scope))
}

/// Select a tool's skills dir for a scope, honoring `env_override` at global
/// scope. `root` is the home dir (global) or project path (project).
///
/// At global scope with `env_override` set in the environment, the tool's global
/// skills base becomes `$ENV/skills` (an absolute path, ignoring `root`).
pub(crate) fn tool_skills_dir(tool: &ToolDef, scope: &str, root: &Path) -> PathBuf {
    match scope {
        "global" => {
            if let Some(var) = tool.env_override {
                if let Some(val) = std::env::var_os(var) {
                    let val = val.to_string_lossy();
                    let trimmed = val.trim();
                    if !trimmed.is_empty() {
                        return PathBuf::from(trimmed).join("skills");
                    }
                }
            }
            root.join(tool.global_skills_dir)
        }
        _ => root.join(tool.project_skills_dir),
    }
}

/// The native agent's tool id in [`TOOL_REGISTRY`].
pub(crate) const ATLAS_TOOL_ID: &str = "atlas";

/// True if `<root>/<tool.config_dir>` exists.
fn tool_detected(root: &Path, def: &ToolDef) -> bool {
    // The native "Atlas" agent is in-process — always available, regardless of
    // whether any `.atlas` dir exists yet at this scope.
    if def.id == ATLAS_TOOL_ID {
        return true;
    }
    root.join(def.config_dir).is_dir()
}

/// Path to a tool's projection entry for a skill at a scope:
/// `<tool_skills_dir>/<name>`.
pub(crate) fn tool_link_path(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> PathBuf {
    tool_skills_dir(def, scope, root).join(safe_name)
}

/// Whether any entry (symlink or copy) for this skill exists in the tool dir.
fn tool_has_entry(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> bool {
    tool_link_path(root, def, scope, safe_name)
        .symlink_metadata()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_code_homes_resolve_for_supported_kinds() {
        let cc = tool_def("claude-code").unwrap();
        // Agent/command/rule are dir homes at both scopes.
        for scope in ["global", "project"] {
            let agent = tool_home(cc, ComponentKind::Agent, scope).unwrap();
            assert_eq!(agent.rel, ".claude/agents");
            assert_eq!(agent.style, HomeStyle::Dir);
            assert_eq!(
                tool_home(cc, ComponentKind::Command, scope).unwrap().rel,
                ".claude/commands"
            );
            assert_eq!(
                tool_home(cc, ComponentKind::Rule, scope).unwrap().rel,
                ".claude/rules"
            );
            // Hooks merge into settings.json.
            let hook = tool_home(cc, ComponentKind::Hook, scope).unwrap();
            assert_eq!(hook.rel, ".claude/settings.json");
            assert_eq!(hook.style, HomeStyle::SettingsMerge);
        }
        // Skills are never represented in homes (they use tool_skills_dir).
        assert!(tool_home(cc, ComponentKind::Skill, "global").is_none());
    }

    #[test]
    fn codex_homes_are_a_subset_and_respect_scope() {
        let codex = tool_def("codex").unwrap();
        // Commands are global-only for Codex.
        assert_eq!(
            tool_home(codex, ComponentKind::Command, "global")
                .unwrap()
                .rel,
            ".codex/prompts"
        );
        assert!(tool_home(codex, ComponentKind::Command, "project").is_none());
        // Rules append to AGENTS.md at both scopes.
        let rule = tool_home(codex, ComponentKind::Rule, "project").unwrap();
        assert_eq!(rule.rel, "AGENTS.md");
        assert_eq!(rule.style, HomeStyle::AppendFile);
        // Codex supports neither agents nor hooks.
        assert!(tool_home(codex, ComponentKind::Agent, "global").is_none());
        assert!(tool_home(codex, ComponentKind::Hook, "global").is_none());
    }
}
