//! Packs through the public interface, with the fetch seam filled by a
//! directory on disk: preview, install, the lockfile's contents, update,
//! projection, freeze and uninstall. No network and no `git`.

mod common;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use atlas_skills::{ComponentKind, PackInstallState};
use common::{pack_repo, project_root, project_store, skill_md, snapshot, write};

/// The clock of the one test that reads it.
static NOW: AtomicU64 = AtomicU64::new(0);

fn now() -> u64 {
    NOW.load(Ordering::SeqCst)
}

fn lock(root: &Path) -> serde_json::Value {
    let raw = fs::read_to_string(root.join(".atlas/packs/skills-lock.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn a_pack_is_previewed_installed_updated_projected_and_uninstalled() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path()).with_clock(now);
    let src = pack_repo();

    // Preview parses the source and installs nothing.
    let before = snapshot(root.path());
    let preview = atlas_skills::preview_pack(&src, "owner/repo").unwrap();
    assert_eq!(preview.name, "demo-pack");
    let kinds: Vec<ComponentKind> = preview.components.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ComponentKind::Agent,
            ComponentKind::Command,
            ComponentKind::Hook,
            ComponentKind::Rule,
            ComponentKind::Script,
            ComponentKind::Skill
        ]
    );
    assert_eq!(before, snapshot(root.path()));
    assert!(store.packs().unwrap().is_empty());

    // Install: the tree lands in the pack store and the lock records it.
    NOW.store(1_000, Ordering::SeqCst);
    let fresh = store.install_pack(&src, "owner/repo", false).unwrap();
    assert_eq!(fresh.state, PackInstallState::Fresh);
    assert_eq!(fresh.pack.name, "demo-pack");
    let pack_dir = root.path().join(".atlas/packs/demo-pack");
    assert!(pack_dir.join("skills/foo/SKILL.md").is_file());
    assert!(pack_dir.join("scripts/setup.js").is_file());
    assert_eq!(
        lock(root.path()),
        serde_json::json!({
            "version": 1,
            "packs": { "demo-pack": {
                "source": "owner/repo",
                "commit": "c1",
                "contentHash": fresh.content_hash,
                "installedAt": 1_000,
                "updatedAt": 1_000,
            }}
        })
    );
    let fetched = src.last_fetched.lock().unwrap().clone().unwrap();
    assert!(
        !fetched.exists(),
        "the fetched tree is removed after install"
    );

    // The same content again is a no-op: the lock keeps its timestamps.
    NOW.store(2_000, Ordering::SeqCst);
    let again = store.install_pack(&src, "owner/repo", false).unwrap();
    assert_eq!(again.state, PackInstallState::AlreadyInstalled);
    assert_eq!(lock(root.path())["packs"]["demo-pack"]["updatedAt"], 1_000);

    // The source moves on. The update check asks for the head commit only.
    let fetches = src.fetch_count();
    assert!(
        !store
            .check_pack_update(&src, "demo-pack")
            .unwrap()
            .has_update
    );
    write(
        &src.path().join("skills/foo/SKILL.md"),
        &skill_md("foo", "The foo skill", "CHANGED"),
    );
    src.set_commit("c2");
    let check = store.check_pack_update(&src, "demo-pack").unwrap();
    assert!(check.has_update);
    assert_eq!(check.remote_commit, "c2");
    assert_eq!(
        src.fetch_count(),
        fetches,
        "an update check fetches no content"
    );

    NOW.store(3_000, Ordering::SeqCst);
    let updated = store.install_pack(&src, "owner/repo", false).unwrap();
    assert_eq!(updated.state, PackInstallState::Updated);
    assert_ne!(updated.content_hash, fresh.content_hash);
    assert_eq!(
        lock(root.path())["packs"]["demo-pack"],
        serde_json::json!({
            "source": "owner/repo",
            "commit": "c2",
            "contentHash": updated.content_hash,
            "installedAt": 1_000,
            "updatedAt": 3_000,
        })
    );
    assert!(fs::read_to_string(pack_dir.join("skills/foo/SKILL.md"))
        .unwrap()
        .contains("CHANGED"));
    let installed = store.packs().unwrap();
    assert_eq!(installed.len(), 1);
    assert_eq!(
        (installed[0].source.as_str(), installed[0].commit.as_str()),
        ("owner/repo", "c2")
    );
    assert_eq!(
        (installed[0].installed_at, installed[0].updated_at),
        (1_000, 3_000)
    );

    // Its skill is a skill, badged with the pack, before any projection.
    let foo = store
        .list()
        .unwrap()
        .into_iter()
        .find(|s| s.name == "foo")
        .unwrap();
    assert_eq!(foo.pack.as_deref(), Some("demo-pack"));
    assert!(!foo.managed);
    assert_eq!(store.read("foo").unwrap().body.trim(), "CHANGED");

    // Project two kinds by tag; an unknown tag is dropped.
    let kinds = [
        "agent".to_string(),
        "skill".to_string(),
        "bogus".to_string(),
    ];
    let report = store
        .project_pack("demo-pack", "claude-code", Some(&kinds), false)
        .unwrap();
    assert_eq!(report.len(), 2);
    assert!(report.iter().all(|r| r.status == "projected"));
    let agent = root.path().join(".claude/agents/rev.md");
    assert!(agent.symlink_metadata().unwrap().file_type().is_symlink());
    assert!(root.path().join(".claude/skills/foo/SKILL.md").is_file());
    assert!(!root.path().join(".claude/commands/ship.md").exists());
    let views = store.pack_projections("demo-pack").unwrap();
    assert_eq!(views.len(), 2);
    assert!(views
        .iter()
        .any(|v| v.kind == ComponentKind::Agent && v.target_rel == ".claude/agents/rev.md"));
    let components = store.pack_components();
    let rev = components.iter().find(|c| c.name == "rev").unwrap();
    assert_eq!(rev.enabled_agents, ["claude-code"]);
    assert_eq!(rev.description, "Reviews");
    let ship = components.iter().find(|c| c.name == "ship").unwrap();
    assert!(ship.enabled_agents.is_empty());
    // The skill's cell belongs to the pack, so the Skills side refuses it.
    let cell = store
        .reconcile()
        .unwrap()
        .skills
        .into_iter()
        .find(|s| s.name == "foo")
        .unwrap()
        .cells
        .into_iter()
        .find(|c| c.tool == "claude-code")
        .unwrap();
    assert_eq!(
        (cell.status.as_str(), cell.pack.as_deref()),
        ("pack", Some("demo-pack"))
    );

    // Freeze is about skill projections: the pack, its lock and its links stay.
    let lock_before = lock(root.path());
    store.freeze().unwrap();
    assert_eq!(lock(root.path()), lock_before);
    assert!(agent.symlink_metadata().unwrap().file_type().is_symlink());

    // Uninstall: links, store dir and lock entry all go; a second one is a no-op.
    store.uninstall_pack("demo-pack").unwrap();
    assert!(agent.symlink_metadata().is_err());
    assert!(root
        .path()
        .join(".claude/skills/foo")
        .symlink_metadata()
        .is_err());
    assert!(!pack_dir.exists());
    assert_eq!(
        lock(root.path()),
        serde_json::json!({ "version": 1, "packs": {} })
    );
    assert!(store.packs().unwrap().is_empty());
    assert!(store.pack_projections("demo-pack").unwrap().is_empty());
    assert!(store.list().unwrap().is_empty());
    store.uninstall_pack("demo-pack").unwrap();
}

#[test]
fn an_unsafe_source_is_refused_before_anything_is_fetched() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    let src = pack_repo();
    let before = snapshot(root.path());

    for source in [
        "-evil/repo",
        "owner/--upload-pack=x",
        "ow ner/repo",
        "justone",
        "",
    ] {
        assert!(
            store.install_pack(&src, source, false).is_err(),
            "{source:?}"
        );
        assert!(
            store.install_skill(&src, source, "foo").is_err(),
            "{source:?}"
        );
        assert!(
            atlas_skills::preview_pack(&src, source).is_err(),
            "{source:?}"
        );
    }

    assert_eq!(src.fetch_count(), 0);
    assert_eq!(before, snapshot(root.path()));
}

#[test]
fn an_unmanaged_directory_in_the_pack_store_is_a_conflict_until_forced() {
    let home = tempfile::tempdir().unwrap();
    let root = project_root();
    let store = project_store(home.path(), root.path());
    let src = pack_repo();
    let theirs = root.path().join(".atlas/packs/demo-pack/theirs.txt");
    write(&theirs, "not ours");

    let conflict = store.install_pack(&src, "owner/repo", false).unwrap();
    assert_eq!(conflict.state, PackInstallState::Conflict);
    assert!(theirs.is_file());
    assert!(!root.path().join(".atlas/packs/skills-lock.json").exists());

    let forced = store.install_pack(&src, "owner/repo", true).unwrap();
    assert_eq!(forced.state, PackInstallState::Fresh);
    assert!(!theirs.exists());
}

#[test]
fn a_pack_directory_is_inspected_without_installing_it() {
    let src = pack_repo();
    let pack = atlas_skills::inspect_pack(src.path()).unwrap();
    assert_eq!(pack.name, "demo-pack");
    assert_eq!(
        pack.manifest.unwrap().description.as_deref(),
        Some("a demo")
    );
    assert_eq!(pack.components.len(), 6);
    let missing = src.path().join("nope");
    assert_eq!(
        atlas_skills::inspect_pack(&missing).unwrap_err(),
        format!("pack path is not a directory: {}", missing.display())
    );
}
