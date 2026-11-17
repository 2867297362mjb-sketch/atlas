//! The skill library through its public interface: a skill installed, listed,
//! read, toggled and deleted; reconcile; promote; and the rule the UI relies
//! on that only a successful write changes anything on disk.
//!
//! The store has no "write a skill" operation: manual authoring was removed,
//! and a managed skill arrives by install or by adopting an external one.

mod common;

use std::fs;

use atlas_skills::SkillStore;
use common::{project_root, project_store, skill_md, skill_repo, snapshot, write};

#[test]
fn a_skill_is_installed_listed_read_toggled_and_deleted() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    let src = skill_repo();
    assert!(store.list().unwrap().is_empty());

    // Install: the skill lands in the canonical store and is linked into
    // every detected agent at once.
    let meta = store
        .install_skill(&src, "owner/repo", "pdf-extract")
        .unwrap();
    assert_eq!(meta.name, "pdf-extract");
    assert_eq!(meta.description, "Pull text out of PDFs");
    assert_eq!(meta.scope, "project");
    assert!(meta.managed);
    assert_eq!(meta.enabled_agents, ["atlas", "claude-code", "codex"]);
    let canonical = root.path().join(".agents/skills/pdf-extract");
    assert!(
        canonical.join("notes.txt").is_file(),
        "the whole dir is copied"
    );
    let fetched = src.last_fetched.lock().unwrap().clone().unwrap();
    assert!(
        !fetched.exists(),
        "the fetched tree is removed after install"
    );

    // List and read give back what was installed.
    let listed = store.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "pdf-extract");
    assert!(listed[0].managed);
    assert_eq!(listed[0].path, meta.path);
    let content = store.read("pdf-extract").unwrap();
    assert_eq!(content.name, "pdf-extract");
    assert_eq!(content.description, "Pull text out of PDFs");
    assert_eq!(content.body.trim(), "Use pdftotext.");
    assert_eq!(
        content.raw,
        fs::read_to_string(canonical.join("SKILL.md")).unwrap()
    );
    assert_eq!(store.path("pdf-extract").unwrap(), meta.path);
    assert!(meta.path.ends_with(".agents/skills/pdf-extract/SKILL.md"));

    // Disable and re-enable one agent: its link goes and comes back.
    let link = root.path().join(".claude/skills/pdf-extract");
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    store
        .set_enabled("pdf-extract", "claude-code", false)
        .unwrap();
    assert!(link.symlink_metadata().is_err());
    assert_eq!(store.list().unwrap()[0].enabled_agents, ["codex", "atlas"]);
    store
        .set_enabled("pdf-extract", "claude-code", true)
        .unwrap();
    assert_eq!(
        fs::read_to_string(link.join("SKILL.md")).unwrap(),
        content.raw
    );

    // Delete: the canonical dir and every link are gone.
    store.delete("pdf-extract").unwrap();
    assert!(!canonical.exists());
    assert!(link.symlink_metadata().is_err());
    assert!(store.list().unwrap().is_empty());
}

#[test]
fn an_external_skill_is_adopted_into_the_store() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    write(
        &root.path().join(".claude/skills/wild/SKILL.md"),
        &skill_md("wild", "Hand written", "body"),
    );
    let before = store.list().unwrap();
    assert_eq!(before.len(), 1);
    assert!(!before[0].managed);
    assert_eq!(before[0].enabled_agents, ["claude-code"]);

    let meta = store.adopt("wild").unwrap();
    assert!(meta.managed);
    assert!(root.path().join(".agents/skills/wild/SKILL.md").is_file());
    let after = store.list().unwrap();
    assert_eq!(after.len(), 1);
    assert!(after[0].managed);
}

#[test]
fn reconcile_run_twice_reports_the_same_and_changes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    store
        .install_skill(&skill_repo(), "owner/repo", "pdf-extract")
        .unwrap();
    write(
        &root.path().join(".claude/skills/wild/SKILL.md"),
        &skill_md("wild", "Hand written", "body"),
    );
    // A skill left in the pre-convergence store: the first discovery pass
    // moves it, which is the one write reconcile ever makes.
    write(
        &root.path().join(".atlas/skills/old/SKILL.md"),
        &skill_md("old", "From before", "body"),
    );

    let first = store.reconcile().unwrap();
    let disk = snapshot(root.path());
    let second = store.reconcile().unwrap();

    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    assert_eq!(disk, snapshot(root.path()));

    let status = |skill: &str, tool: &str| {
        let row = first.skills.iter().find(|s| s.name == skill).unwrap();
        let cell = row.cells.iter().find(|c| c.tool == tool).unwrap();
        (row.managed, cell.status.clone())
    };
    assert_eq!(
        status("pdf-extract", "claude-code"),
        (true, "synced".into())
    );
    assert_eq!(status("wild", "claude-code"), (false, "external".into()));
    assert_eq!(status("wild", "atlas"), (false, "absent".into()));
    assert!(status("old", "codex").0, "the legacy skill was migrated");
    assert_eq!(first.tools.len(), 3);
}

#[test]
fn a_project_skill_is_promoted_to_the_global_store() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    store
        .install_skill(&skill_repo(), "owner/repo", "pdf-extract")
        .unwrap();

    let meta = store.promote("pdf-extract").unwrap();

    assert_eq!(meta.scope, "global");
    assert!(meta.managed);
    assert!(home
        .path()
        .join(".agents/skills/pdf-extract/SKILL.md")
        .is_file());
    assert!(
        root.path()
            .join(".agents/skills/pdf-extract/SKILL.md")
            .is_file(),
        "the project keeps its copy"
    );
    // Without a home directory there is nowhere to promote to.
    let homeless = SkillStore::open(None, "project", Some(root.path().to_str().unwrap())).unwrap();
    assert_eq!(
        homeless.promote("pdf-extract").unwrap_err(),
        "could not resolve home directory"
    );
    assert_eq!(
        homeless.reconcile().unwrap_err(),
        "could not resolve home directory"
    );
}

/// The app reports a change (its telemetry event) only when an operation
/// returns `Ok`. That is honest only if a refused operation, and a read, left
/// the disk exactly as it was.
#[test]
fn a_read_or_a_refused_operation_changes_nothing_on_disk() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    let src = skill_repo();
    store
        .install_skill(&src, "owner/repo", "pdf-extract")
        .unwrap();
    // The user replaced Claude Code's link with their own, different, copy.
    let link = root.path().join(".claude/skills/pdf-extract");
    fs::remove_file(&link).unwrap();
    write(
        &link.join("SKILL.md"),
        &skill_md("pdf-extract", "Mine", "edited"),
    );
    let before = (snapshot(root.path()), snapshot(home.path()));

    // Reads.
    store.list().unwrap();
    store.read("pdf-extract").unwrap();
    store.path("pdf-extract").unwrap();
    store.targets();
    store.reconcile().unwrap();
    store.packs().unwrap();
    store.pack_projections("demo-pack").unwrap();
    store.pack_components();
    assert_eq!(before, (snapshot(root.path()), snapshot(home.path())));

    // Refusals, each in the words the UI shows.
    let refused: Vec<(Result<(), String>, &str)> = vec![
        (
            store.project("pdf-extract", "claude-code", false),
            "refusing to overwrite drifted/external 'pdf-extract' in claude-code (use force)",
        ),
        (
            store.unproject("pdf-extract", "codex"),
            "cannot disable codex for 'pdf-extract': its project-scope skills dir is the canonical store itself",
        ),
        (
            store.set_enabled("pdf-extract", "nope", true),
            "unknown agent: nope",
        ),
        (
            store.project("pdf-extract", "nope", false),
            "unknown tool: nope",
        ),
        (
            store.set_enabled("ghost", "claude-code", true),
            "skill not found: ghost",
        ),
        (
            store.project("ghost", "claude-code", false),
            "canonical skill not found: ghost",
        ),
        (store.read("ghost").map(|_| ()), "skill not found: ghost"),
        (store.path("ghost").map(|_| ()), "skill not found: ghost"),
        (
            store.adopt("ghost").map(|_| ()),
            "skill not found to adopt: ghost",
        ),
        (
            store.promote("ghost").map(|_| ()),
            "project skill not found: ghost",
        ),
        (
            store.install_skill(&src, "owner/repo", "ghost").map(|_| ()),
            "skill 'ghost' not found in this repo",
        ),
        (
            store.check_pack_update(&src, "ghost").map(|_| ()),
            "pack not installed: ghost",
        ),
        (
            store
                .project_pack("ghost", "claude-code", None, false)
                .map(|_| ()),
            "pack not installed: ghost",
        ),
    ];
    for (result, expected) in refused {
        assert_eq!(result.unwrap_err(), expected);
    }
    assert_eq!(before, (snapshot(root.path()), snapshot(home.path())));

    // And the forced version of the first refusal does change it.
    store.project("pdf-extract", "claude-code", true).unwrap();
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
}
