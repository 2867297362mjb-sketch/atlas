//! The types that cross IPC: skills, agent targets, packs and their components.

use serde::{Deserialize, Serialize};

// ── Data model ─────────────────────────────────────────────────────────────────

/// Non-secret metadata for one installed skill (what the list view renders).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// Registry agent ids that currently have a symlink to this skill.
    pub enabled_agents: Vec<String>,
    /// Absolute path to the canonical `SKILL.md`.
    pub path: String,
    /// Capability tier from the registry (default `"native-dir"`).
    pub delivery: String,
    /// `true` when this skill exists in the canonical `.agents/skills` store
    /// (Atlas authored/adopted it, or it was placed there by skills.sh/Zed/another
    /// tool — the store is shared). `false` for external skills that only exist
    /// as a real directory inside one or more agent skills dirs.
    pub managed: bool,
    /// When this skill is *provided by an installed pack* (rather than authored
    /// in the canonical store), the originating pack name. `None` for authored
    /// or external skills. Pack-provided skills are still invokable — the
    /// bound agent advertises them over ACP like any other skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
}

/// Full skill contents for editing/preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    /// Body with the frontmatter block stripped.
    pub body: String,
    /// The raw on-disk file, frontmatter included.
    pub raw: String,
}

/// A registry agent as a possible enable target for the current scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub id: String,
    pub display_name: String,
    /// Relative skills dir under `<root>` (e.g. `.claude/skills`).
    pub skills_dir: String,
    pub delivery: String,
    /// Whether the agent's config dir exists under `<root>`.
    pub detected: bool,
}

// ── Pack model (pack-install plan, Phase 0) ────────────────────────────────────
//
// A skills.sh entry is a *pack*: a Claude-Code-plugin-shaped tree that can ship
// several component kinds (skills, agents, commands, hooks, rules, scripts). The
// existing skill machinery below handles exactly one kind ("skill"); these types
// generalize the model to N kinds. They are inert in Phase 0 — parsing
// (`pack_parse`) lands in Phase 1, per-component projection in Phase 3.

/// The kinds of component a pack can ship.
///
/// `script` files live in the canonical pack and are only *referenced* (never
/// auto-run at install) — execution happens later, when an installed hook fires
/// them via the managed Node. See `.claude/plans/skills-pack-install.plan.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    Skill,
    Agent,
    Command,
    Hook,
    Rule,
    Script,
}

impl Default for ComponentKind {
    /// Skill is the default so legacy ledgers (which predate this field)
    /// deserialize as skill projections.
    fn default() -> Self {
        ComponentKind::Skill
    }
}

impl ComponentKind {
    /// Stable lowercase tag (matches the serde representation + ledger storage).
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ComponentKind::Skill => "skill",
            ComponentKind::Agent => "agent",
            ComponentKind::Command => "command",
            ComponentKind::Hook => "hook",
            ComponentKind::Rule => "rule",
            ComponentKind::Script => "script",
        }
    }

    /// Infer a kind from a top-level pack directory name — the "infer from
    /// layout" fallback used when a pack has no `.claude-plugin/plugin.json`.
    /// Plural dir → singular kind; unknown dirs → `None`.
    pub(crate) fn from_dir_name(name: &str) -> Option<Self> {
        match name {
            "skills" => Some(ComponentKind::Skill),
            "agents" => Some(ComponentKind::Agent),
            "commands" => Some(ComponentKind::Command),
            "hooks" => Some(ComponentKind::Hook),
            "rules" => Some(ComponentKind::Rule),
            "scripts" => Some(ComponentKind::Script),
            _ => None,
        }
    }
}

/// One component discovered inside a pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackComponent {
    pub kind: ComponentKind,
    /// Path relative to the pack root, e.g. `agents/review.md` or `skills/foo`.
    pub rel_path: String,
    /// Projection leaf name (the file or dir name placed in a tool home),
    /// e.g. `review` or `foo`.
    pub name: String,
    /// Frontmatter `description` of the component's markdown (the SKILL.md for a
    /// skill, the `.md` body for command/agent/rule). `None` for non-markdown
    /// components or when no description is set. Lets the marketplace preview a
    /// pack's contents — packs themselves usually carry no manifest description.
    #[serde(default)]
    pub description: Option<String>,
}

/// Parsed `.claude-plugin/plugin.json`. Every field is optional — the parser is
/// deliberately tolerant so manifest-light packs still load. `author` is kept as
/// a raw value because the ecosystem uses both a bare string and an object.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<serde_json::Value>,
    // Claude Code plugin component paths. Each is a string or array of strings,
    // relative to the manifest root — they let a plugin keep components in
    // non-conventional locations (e.g. `.claude/skills`, `plugin/hooks/hooks.json`)
    // instead of top-level `skills/`, `hooks/`, etc.
    #[serde(default)]
    pub skills: Option<serde_json::Value>,
    #[serde(default)]
    pub commands: Option<serde_json::Value>,
    #[serde(default)]
    pub agents: Option<serde_json::Value>,
    #[serde(default)]
    pub hooks: Option<serde_json::Value>,
}

/// A parsed pack: canonical name, root dir, the manifest if present, and every
/// component discovered (manifest-declared or inferred from layout).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub manifest: Option<PluginManifest>,
    pub components: Vec<PackComponent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_kind_maps_known_dir_names_and_rejects_others() {
        assert_eq!(
            ComponentKind::from_dir_name("skills"),
            Some(ComponentKind::Skill)
        );
        assert_eq!(
            ComponentKind::from_dir_name("agents"),
            Some(ComponentKind::Agent)
        );
        assert_eq!(
            ComponentKind::from_dir_name("commands"),
            Some(ComponentKind::Command)
        );
        assert_eq!(
            ComponentKind::from_dir_name("hooks"),
            Some(ComponentKind::Hook)
        );
        assert_eq!(
            ComponentKind::from_dir_name("rules"),
            Some(ComponentKind::Rule)
        );
        assert_eq!(
            ComponentKind::from_dir_name("scripts"),
            Some(ComponentKind::Script)
        );
        assert_eq!(ComponentKind::from_dir_name("docs"), None);
        assert_eq!(ComponentKind::from_dir_name(""), None);
    }
}
