//! Bundled skills through the public interface: what a first launch seeds,
//! and what a later launch may and may not overwrite.

use std::fs;

use atlas_profile::Profile;
use atlas_skills::{sync_bundled_skills, SkillStore};

const CONFIG_FILE: &str = "config.toml";

#[test]
fn bundled_skills_are_seeded_once_and_a_user_edit_survives_the_next_sync() {
    // No tool is installed under this home, so nothing is linked anywhere.
    let home = tempfile::tempdir().unwrap();
    let store = SkillStore::open(Some(home.path()), "global", None).unwrap();
    let base = home.path().join(".agents/skills");

    sync_bundled_skills(home.path(), Profile::Default, CONFIG_FILE);

    let listed = store.list().unwrap();
    for name in ["atlas-self-configure", "remember"] {
        let skill = listed
            .iter()
            .find(|s| s.name == name)
            .unwrap_or_else(|| panic!("{name} is seeded"));
        assert!(skill.managed, "{name}");
        assert_eq!(skill.scope, "global");
        assert!(!skill.description.is_empty(), "{name}");
        assert!(base.join(name).join(".bundled-hash").is_file(), "{name}");
        assert!(!store.read(name).unwrap().body.trim().is_empty(), "{name}");
    }
    let shipped = fs::read_to_string(base.join("atlas-self-configure/SKILL.md")).unwrap();

    // The user edits one. The next launch leaves the edit alone and leaves
    // the untouched one as it was.
    let edited = base.join("remember/SKILL.md");
    fs::write(&edited, "---\nname: remember\n---\n\nmine now\n").unwrap();
    sync_bundled_skills(home.path(), Profile::Default, CONFIG_FILE);

    assert_eq!(store.read("remember").unwrap().body.trim(), "mine now");
    assert_eq!(
        fs::read_to_string(base.join("atlas-self-configure/SKILL.md")).unwrap(),
        shipped
    );

    // A deleted bundled skill comes back on the next launch.
    store.delete("remember").unwrap();
    assert!(!edited.exists());
    sync_bundled_skills(home.path(), Profile::Default, CONFIG_FILE);
    assert_ne!(store.read("remember").unwrap().body.trim(), "mine now");
}

/// The dev profile seeds its own self-configure copy, which names the dev
/// profile's config file: the name the app passes in.
#[test]
fn the_dev_profile_seeds_its_own_copy_naming_the_config_file_it_was_given() {
    let home = tempfile::tempdir().unwrap();
    sync_bundled_skills(home.path(), Profile::Dev, "settings.toml");

    let base = home.path().join(".agents/skills");
    assert!(!base.join("atlas-self-configure").exists());
    let dev = fs::read_to_string(base.join("atlas-dev-self-configure/SKILL.md")).unwrap();
    assert!(dev.contains("name: atlas-dev-self-configure"));
    assert!(base.join("remember/SKILL.md").is_file());
    // The note that tells an agent to leave the installed Atlas alone names
    // the installed Atlas's file by the name it was given.
    assert!(dev.contains("`~/.config/atlas/settings.toml`"), "{dev}");
}
