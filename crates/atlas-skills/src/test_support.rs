//! Fixtures shared by the in-module unit tests.

use crate::disk::{atomic_write, create_copy, hash_skill_dir, symlink};
use crate::ledger::{ledger_record, read_ledger, write_ledger};
use crate::model::{ComponentKind, Pack, SkillMeta};
use crate::packs::install::install_pack_from_dir;
use crate::paths::{canonical_skill_dir, sanitize_name, skills_base};
use crate::projection::project;
use crate::registry::{tool_def, tool_link_path, TOOL_REGISTRY};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn tmp_root() -> PathBuf {
    // UUID rather than a nanosecond timestamp: two threads in the same
    // `cargo test` run landed on the same directory often enough to be
    // observed (see `tmp_root_isolated` below, which was added to dodge
    // exactly this), and a collision means one test deletes another's
    // fixture mid-assertion. Fixing the shared helper removes the flake
    // for every test that uses it, not just the bundled-skill ones.
    let mut p = std::env::temp_dir();
    p.push(format!("atlas-skills-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    // Make both v1 tools "detected".
    fs::create_dir_all(p.join(".claude")).unwrap();
    fs::create_dir_all(p.join(".codex")).unwrap();
    p
}

/// `tmp_root()` without the `.claude`/`.codex` detection dirs — the
/// bundled-skill tests below assert on the canonical store itself and
/// don't want either tool to register as detected.
pub(crate) fn tmp_root_isolated() -> PathBuf {
    let p = std::env::temp_dir().join(format!("atlas-skills-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}

/// Plant a real (unmanaged) skill dir directly in an agent's skills dir.
pub(crate) fn plant_external(root: &Path, agent_skills_dir: &str, name: &str, description: &str) {
    let dir = root.join(agent_skills_dir).join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
    )
    .unwrap();
}

/// Plant a real skill dir at `real_rel`, then symlink it into an agent's
/// skills dir at `link_rel` — mirrors what a skills.sh/Zed projection into
/// `.claude/skills` looks like from Atlas's point of view.
pub(crate) fn plant_symlinked_external(root: &Path, real_rel: &str, link_rel: &str, name: &str) {
    let real_dir = root.join(real_rel).join(name);
    fs::create_dir_all(&real_dir).unwrap();
    fs::write(
        real_dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: symlinked\n---\n\nbody\n"),
    )
    .unwrap();
    let link_parent = root.join(link_rel);
    fs::create_dir_all(&link_parent).unwrap();
    symlink(&real_dir, &link_parent.join(name)).unwrap();
}

/// Build a fresh empty temp dir for a pack fixture.
///
/// UUID, for the same reason `tmp_root()` above uses one. This helper was
/// added a day after `tmp_root()` was switched over (2026-06-25 vs 06-24)
/// and kept the discarded `pid` + `SystemTime` form — two months before the
/// comment explaining why that form is unsafe was written.
///
/// `pid` is constant across every test in the binary, and `SystemTime::now()`
/// is not nanosecond-unique: on macOS it advances in 1 µs steps (measured —
/// 139,798 duplicate stamps per 160,000 across 8 threads). Two of the 16
/// call sites here can land on the SAME directory, and each ends in
/// `fs::remove_dir_all`, so the loser's fixture is deleted mid-test —
/// observed as `pack_project_claude_links_agent_and_skill_and_records_ledger`
/// failing on `skill_link.symlink_metadata().is_ok()` a beat after the agent
/// assertion above it passed, and passing on its own or on a re-run.
pub(crate) fn tmp_pack_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("atlas-pack-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}

pub(crate) fn write_file(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

/// Tests below create tool dirs under a temp root; an env override would
/// send the links to the real `$CLAUDE_CONFIG_DIR`/`$CODEX_HOME` instead.
pub(crate) fn tool_env_overridden() -> bool {
    TOOL_REGISTRY
        .iter()
        .filter_map(|t| t.env_override)
        .any(|v| std::env::var_os(v).is_some())
}

pub(crate) fn comp_names(pack: &Pack, kind: ComponentKind) -> Vec<String> {
    pack.components
        .iter()
        .filter(|c| c.kind == kind)
        .map(|c| c.name.clone())
        .collect()
}

/// Build a minimal pack fixture (a "fetched repo" tree) under a fresh dir.
pub(crate) fn make_src_pack(name_marker: &str) -> PathBuf {
    let dir = tmp_pack_dir();
    write_file(
        &dir.join(".claude-plugin/plugin.json"),
        &format!(r#"{{"name":"demo-pack","description":"{name_marker}"}}"#),
    );
    write_file(
        &dir.join("skills/foo/SKILL.md"),
        "---\nname: foo\n---\nbody",
    );
    write_file(&dir.join("agents/rev.md"), "agent");
    dir
}

/// A richer pack fixture: skill + agent + command + rule + hooks + script.
pub(crate) fn make_full_src_pack() -> PathBuf {
    let dir = tmp_pack_dir();
    write_file(
        &dir.join(".claude-plugin/plugin.json"),
        r#"{"name":"demo-pack"}"#,
    );
    write_file(
        &dir.join("skills/foo/SKILL.md"),
        "---\nname: foo\n---\nbody",
    );
    write_file(&dir.join("agents/rev.md"), "agent");
    write_file(&dir.join("commands/ship.md"), "command");
    write_file(&dir.join("rules/style.md"), "rule body");
    write_file(
        &dir.join("hooks/hooks.json"),
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"}]}]}}"#,
    );
    write_file(&dir.join("scripts/setup.js"), "console.log(1)");
    dir
}

/// A root with `.claude`/`.codex` present (tools "detected") + the pack installed.
pub(crate) fn installed_root(src: &Path) -> PathBuf {
    let root = tmp_pack_dir();
    fs::create_dir_all(root.join(".claude")).unwrap();
    fs::create_dir_all(root.join(".codex")).unwrap();
    install_pack_from_dir(&root, src, "owner/repo", "c1", false).unwrap();
    root
}

/// A detected root with `demo-pack` (ships skill `foo`) installed.
pub(crate) fn root_with_installed_pack() -> PathBuf {
    let root = tmp_root();
    let src = make_src_pack("v1");
    install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
    fs::remove_dir_all(&src).ok();
    root
}

/// Render a `SKILL.md` with frontmatter for the given fields. Only used by the
/// test-only `create_skill` helper now that manual authoring is removed.
pub(crate) fn render_skill_md(name: &str, description: &str, body: &str) -> String {
    // Keep values single-line; frontmatter is scalar-only here.
    let desc = description.replace(['\n', '\r'], " ");
    format!(
        "---\nname: {name}\ndescription: {desc}\n---\n\n{}\n",
        body.trim_end()
    )
}

// Manual skill authoring (the `skills_create` IPC command) was removed; skills
// now come from packs. `create_skill` is retained only as a test setup helper.
pub(crate) fn create_skill(
    root: &Path,
    scope: &str,
    name: &str,
    description: &str,
    body: &str,
    agents: &[String],
) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");

    let existed = skill_md.is_file();
    let contents = render_skill_md(&safe, description, body);
    atomic_write(&skill_md, &contents)?;

    // Enable for each requested registry tool (symlink/copy via the engine).
    let mut enabled_agents = Vec::new();
    for agent in agents {
        if let Some(def) = tool_def(agent) {
            project(root, def, scope, &safe, false)?;
            enabled_agents.push(def.id.to_string());
        }
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    // Edit-propagation: if this was an edit of an existing canonical skill,
    // re-push copy projections (symlinks read through the link for free). A copy
    // that is currently drifted is left untouched for explicit resolution.
    if existed {
        propagate_edit(root, scope, &safe)?;
    }

    Ok(SkillMeta {
        name: safe,
        description: description.replace(['\n', '\r'], " "),
        scope: scope.to_string(),
        enabled_agents,
        path: skill_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

// ── Edit propagation (CP.3) ──────────────────────────────────────────────────────

/// Re-push copy projections after a canonical edit. Symlinks read through the
/// link, so nothing to do for them. A copy whose on-disk hash already differs
/// from its ledger-recorded hash is *drifted* (edited out-of-band) → leave it
/// for explicit resolution, never silently overwrite.
pub(crate) fn propagate_edit(root: &Path, scope: &str, safe_name: &str) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    let mut ledger = read_ledger(root);
    let Some(tools) = ledger.projections.get(safe_name).cloned() else {
        return Ok(());
    };
    for (tool_id, entry) in tools {
        if entry.mode != "copy" {
            continue;
        }
        let Some(def) = tool_def(&tool_id) else {
            continue;
        };
        let link = tool_link_path(root, def, scope, safe_name);
        let on_disk = hash_skill_dir(&link);
        // Drifted: the copy diverged from what we last pushed → block silent push.
        if !on_disk.is_empty() && on_disk != entry.hash {
            continue;
        }
        if on_disk == canonical_hash {
            continue; // already in sync
        }
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, &tool_id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}
