//! The skill store.
//!
//! Atlas manages agent "skills" the same way the `skills` CLI and Zed do: a
//! single **canonical store** — `~/.agents/skills` (global) / `<project>/.agents/skills`
//! (project) — holds the authored `SKILL.md`, and each agent that should "see"
//! the skill gets a **symlink** into its own skills directory. Disk *is* the
//! state — there is no separate enable/disable file. See
//! `docs/adr/0005-agents-skills-is-the-canonical-store-acp-advertisement-is-the-picker.md`:
//! Atlas does not run its own second store anymore, it reads/writes the same
//! `.agents/skills` tree skills.sh and Zed already use.
//!
//! ```text
//! canonical (= installed, managed by Atlas):
//!   <root>/.agents/skills/<name>/SKILL.md
//! enablement (= symlink present, what the agent reads):
//!   <root>/.claude/skills/<name> -> ../../.agents/skills/<name>
//! ```
//!
//! `<root>` is the home dir (global scope) or the project path (project scope).
//! The agent registry is a static table for v1 (Claude Code + Codex, and the
//! native agent); detection is "does the agent's config dir exist under
//! `<root>`?". Note Codex's own *project*-scope skills dir was already
//! `.agents/skills` before this store converged onto the same path — see the
//! native-location guard in `projection`.
//!
//! Discovery also surfaces **external** skills: real directories (or symlinks
//! to directories, e.g. a skills.sh/Zed projection) that live directly in an
//! agent's skills dir (e.g. `~/.claude/skills/<name>/SKILL.md`) and are not the
//! canonical store's own entries. These are `managed = false`; the "Make for
//! all agents" (adopt) operation copies them into the canonical store and fans
//! them out to every detected agent via symlink.
//!
//! A pre-convergence Atlas install may still have content sitting in the old
//! `.atlas/skills` store; discovery moves it into the canonical store the
//! first time it finds it.
//!
//! Security: skill names are sanitized and every resolved path is verified to
//! stay inside `<root>/.agents/skills` so a crafted name can't escape via `..`.
//!
//! # What this crate is given
//!
//! It never looks anything up about the machine or the app:
//!
//! - **the home directory**, to [`SkillStore::open`] and
//!   [`sync_bundled_skills`];
//! - **where pack content comes from**, as a [`PackSource`] ([`GitHub`] in the
//!   app, a directory on disk in a test);
//! - **the clock** the pack lock's timestamps are read from
//!   ([`SkillStore::with_clock`]; the system clock otherwise);
//! - **the config file's name**, which the dev profile's bundled skill names.
//!
//! Everything here blocks on the filesystem (and, through a [`PackSource`], on
//! the network): call it from `spawn_blocking`.
//!
//! Errors are `String`s, worded for the UI that shows them.

mod bundled;
mod disk;
mod frontmatter;
mod ledger;
mod library;
mod model;
mod packs;
mod paths;
mod projection;
mod reconcile;
mod registry;
#[cfg(test)]
mod test_support;

use std::path::{Path, PathBuf};

pub use bundled::sync_bundled_skills;
pub use model::{
    AgentTarget, ComponentKind, Pack, PackComponent, PluginManifest, SkillContent, SkillMeta,
};
pub use packs::install::{
    InstalledPack, PackInstallResult, PackInstallState, PackSearchHit, PackSearchResponse,
    PackUpdateCheck,
};
pub use packs::projection::{PackComponentMeta, PackProjectReport, PackProjectionView};
pub use packs::source::{GitHub, PackSource};
pub use reconcile::{ProjectionCell, ReconcileView, ReconciledSkill, ToolInfo};

/// The skills.sh search endpoint. Discovery only: the request is the app's to
/// make, and [`PackSearchResponse`] is the body it decodes.
pub const PACK_SEARCH_URL: &str = packs::install::SKILLS_SEARCH_URL;

/// Inspect a pack directory on disk and return its manifest + component listing.
/// Read-only — nothing is installed, projected, or executed.
pub fn inspect_pack(dir: &Path) -> Result<Pack, String> {
    packs::parse::pack_parse(dir)
}

/// Fetch a pack's source and parse it WITHOUT installing — for the
/// install-preview UI (shows every component the pack ships).
pub fn preview_pack(from: &dyn PackSource, source: &str) -> Result<Pack, String> {
    packs::install::preview_pack(from, source)
}

/// The skill store of one scope: the global one under the home directory, or
/// one project's.
///
/// Opening it touches nothing on disk. Every operation resolves its paths from
/// the root and the scope, so a store is cheap to open per call.
#[derive(Debug, Clone)]
pub struct SkillStore {
    /// The home directory (global scope) or the project path (project scope).
    root: PathBuf,
    /// `"global"` | `"project"`.
    scope: String,
    /// The home directory, which a project's store still needs to report what
    /// is installed globally and to promote a skill.
    home: Option<PathBuf>,
    clock: fn() -> u64,
}

impl SkillStore {
    /// Open the store for `scope` (`"global"` | `"project"`). `home` is the
    /// user's home directory, if it could be resolved; `project_path` is
    /// required at project scope and refused if it holds a `..` segment.
    pub fn open(
        home: Option<&Path>,
        scope: &str,
        project_path: Option<&str>,
    ) -> Result<Self, String> {
        let root = paths::root_for(home, scope, project_path)?;
        Ok(Self {
            root,
            scope: scope.to_string(),
            home: home.map(Path::to_path_buf),
            clock: packs::install::now_unix_secs,
        })
    }

    /// Read the pack lock's timestamps (unix seconds) from `clock` instead of
    /// the system clock.
    pub fn with_clock(mut self, clock: fn() -> u64) -> Self {
        self.clock = clock;
        self
    }

    fn home(&self) -> Result<&Path, String> {
        self.home
            .as_deref()
            .ok_or_else(|| "could not resolve home directory".to_string())
    }

    // ── Skills ──────────────────────────────────────────────────────────────

    /// List installed skills (canonical store scan + per-agent enable), the
    /// tools' own external skills, and the skills installed packs provide.
    pub fn list(&self) -> Result<Vec<SkillMeta>, String> {
        library::list_skills(&self.root, &self.scope)
    }

    /// Read one skill's frontmatter + body (for editing/preview).
    pub fn read(&self, name: &str) -> Result<SkillContent, String> {
        library::read_skill(&self.root, name)
    }

    /// Absolute path to a skill's `SKILL.md` (for opening in the editor).
    pub fn path(&self, name: &str) -> Result<String, String> {
        library::skill_path(&self.root, name)
    }

    /// Adopt an external/single-agent skill: copy it into the canonical store
    /// (if not already there) and symlink it into every detected agent ("Make
    /// for all agents"). Returns the now-managed skill.
    pub fn adopt(&self, name: &str) -> Result<SkillMeta, String> {
        library::adopt_skill(&self.root, &self.scope, name)
    }

    /// Enable/disable a single agent for a skill (create/remove its symlink).
    pub fn set_enabled(&self, name: &str, agent: &str, enabled: bool) -> Result<(), String> {
        library::set_enabled(&self.root, &self.scope, name, agent, enabled)
    }

    /// Delete a skill: remove every agent symlink, then the canonical dir.
    pub fn delete(&self, name: &str) -> Result<(), String> {
        library::delete_skill(&self.root, &self.scope, name)
    }

    /// The registry's agents as enable targets, with whether each is detected.
    pub fn targets(&self) -> Vec<AgentTarget> {
        library::list_targets(&self.root, &self.scope)
    }

    /// Build the reconciled skill × tool matrix.
    pub fn reconcile(&self) -> Result<ReconcileView, String> {
        let home = self.home()?;
        reconcile::reconcile(&self.root, &self.scope, home)
    }

    /// Project a canonical skill into one tool (symlink/copy + ledger). Refuses
    /// to overwrite a drifted, external or pack-owned entry unless `force`.
    pub fn project(&self, name: &str, tool: &str, force: bool) -> Result<(), String> {
        projection::project_named(&self.root, &self.scope, name, tool, force)
    }

    /// Remove a projection (symlink/copy) of a skill from one tool + drop its
    /// ledger entry.
    pub fn unproject(&self, name: &str, tool: &str) -> Result<(), String> {
        projection::unproject_named(&self.root, &self.scope, name, tool)
    }

    /// Promote this project's skill to the global library + re-project it at
    /// global scope. The project's copy is kept.
    pub fn promote(&self, name: &str) -> Result<SkillMeta, String> {
        let home = self.home()?;
        library::promote(&self.root, home, name)
    }

    /// Freeze every Atlas symlink projection into a real copy (uninstall safety).
    pub fn freeze(&self) -> Result<(), String> {
        projection::freeze(&self.root, &self.scope)
    }

    /// Install a single skill (`skill_id`) from a `source` repo as a managed
    /// skill, projected into every detected agent.
    pub fn install_skill(
        &self,
        from: &dyn PackSource,
        source: &str,
        skill_id: &str,
    ) -> Result<SkillMeta, String> {
        library::install_skill_from_source(&self.root, &self.scope, from, source, skill_id)
    }

    // ── Packs ───────────────────────────────────────────────────────────────

    /// Install a pack from its source into the store: fetches the whole repo,
    /// dedups against the lock, writes `skills-lock.json`. No projection and
    /// no script execution.
    pub fn install_pack(
        &self,
        from: &dyn PackSource,
        source: &str,
        force: bool,
    ) -> Result<PackInstallResult, String> {
        packs::install::install_pack_from_source(&self.root, from, source, force, &self.clock)
    }

    /// Packs installed in this scope (manifest + provenance).
    pub fn packs(&self) -> Result<Vec<InstalledPack>, String> {
        packs::install::list_installed_packs(&self.root)
    }

    /// Whether an installed pack is behind its source (no content is fetched).
    pub fn check_pack_update(
        &self,
        from: &dyn PackSource,
        pack: &str,
    ) -> Result<PackUpdateCheck, String> {
        packs::install::check_pack_update(&self.root, from, pack)
    }

    /// Fully remove an installed pack: unproject it from every tool, delete
    /// its store dir, drop its lock entry. Idempotent.
    pub fn uninstall_pack(&self, pack: &str) -> Result<(), String> {
        packs::install::uninstall_pack(&self.root, pack)
    }

    /// Project an installed pack's components into a tool, optionally only the
    /// kinds tagged in `kinds` (`"agent"`, `"skill"`, …).
    pub fn project_pack(
        &self,
        pack: &str,
        tool: &str,
        kinds: Option<&[String]>,
        force: bool,
    ) -> Result<Vec<PackProjectReport>, String> {
        packs::projection::project_pack_tagged(&self.root, &self.scope, pack, tool, kinds, force)
    }

    /// Undo every projection of a pack into a tool.
    pub fn unproject_pack(&self, pack: &str, tool: &str) -> Result<(), String> {
        packs::projection::unproject_pack(&self.root, pack, tool)
    }

    /// Read-only projection ledger view for one pack.
    pub fn pack_projections(&self, pack: &str) -> Result<Vec<PackProjectionView>, String> {
        packs::projection::list_pack_projections(&self.root, pack)
    }

    /// Every invokable component (command/agent/rule) across installed packs.
    pub fn pack_components(&self) -> Vec<PackComponentMeta> {
        packs::projection::pack_components(&self.root)
    }
}
