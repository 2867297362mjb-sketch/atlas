//! The skills Atlas ships in its binary and seeds into the global store.

use crate::paths::skills_base;
use crate::projection::project;
use crate::registry::{tool_def, tool_detected, tool_has_entry};
use std::borrow::Cow;
use std::fs;
use std::path::Path;

// ── Bundled skills (issue #64) ──────────────────────────────────────────────

/// A skill Atlas ships inside its own binary and seeds into the canonical
/// **global** store on launch. The content is compiled in with `include_str!`,
/// so installing/upgrading it needs no separate resource-bundling config.
struct BundledSkill {
    /// Directory name under `~/.agents/skills`; also the `name` in the
    /// skill's frontmatter, which is what an agent advertises it as.
    name: &'static str,
    /// The whole `SKILL.md`, embedded at build time.
    skill_md: &'static str,
}

/// Inspect and safely update Atlas's `config.toml` (issue #64).
const ATLAS_SELF_CONFIGURE: BundledSkill = BundledSkill {
    name: "atlas-self-configure",
    skill_md: include_str!("../../../src-tauri/resources/skills/atlas-self-configure/SKILL.md"),
};

/// `/remember`: save what the conversation established to Atlas's shared
/// memory through the `atlas_memory` tools. Also what save-before-switch
/// sends (`switch-agent.ts`), when the agent advertises it.
const REMEMBER: BundledSkill = BundledSkill {
    name: "remember",
    skill_md: include_str!("../../../src-tauri/resources/skills/remember/SKILL.md"),
};

/// Every skill Atlas ships. All of them go through the same seeding code.
const BUNDLED_SKILLS: &[BundledSkill] = &[ATLAS_SELF_CONFIGURE, REMEMBER];

/// The same skill as the dev profile (`bun run dev:app`) seeds it: under a
/// name of its own, pointing at the dev profile's config. See
/// [`bundled_skill`].
const DEV_BUNDLED_SKILL_NAME: &str = "atlas-dev-self-configure";

/// A bundled skill as `profile` seeds it: its directory name and `SKILL.md`.
///
/// Every skill in the default profile, and every skill but self-configure in
/// the dev profile, is the shipped text byte for byte under its own name.
///
/// The dev profile seeds self-configure's text, so a change to the skill can be tried
/// under `dev:app`, with two differences. Its paths are the dev profile's
/// (`~/.config/atlas-dev/config.toml`, `.atlas-dev/`), because an agent that
/// followed the released text from inside Atlas Dev would edit the installed
/// Atlas's settings. And it has its own name: the canonical store
/// (`~/.agents/skills`) is shared with the installed Atlas and other tools,
/// so under the same name each build would overwrite the other's copy on
/// every launch (each sees its own hash sidecar and calls the file
/// untouched). Under its own name the two copies sit side by side, each with
/// its own sidecar, and the installed Atlas's copy is never written.
///
/// `config_file` is the name of Atlas's config file (`config.toml`), which
/// the app owns and passes in.
fn bundled_skill(
    skill: &BundledSkill,
    profile: atlas_profile::Profile,
    config_file: &str,
) -> (&'static str, Cow<'static, str>) {
    use atlas_profile::Profile;
    if !profile.is_dev() || skill.name != ATLAS_SELF_CONFIGURE.name {
        return (skill.name, Cow::Borrowed(skill.skill_md));
    }
    let config = |p: Profile| format!("/{}/{config_file}", p.config_dir_name());
    let project_dir = |p: Profile| format!("`{}/`", p.dir_name());
    let installed_config = format!("~/.config{}", config(Profile::Default));

    let mut out = String::with_capacity(ATLAS_SELF_CONFIGURE.skill_md.len() + 512);
    let mut noted = false;
    for line in ATLAS_SELF_CONFIGURE.skill_md.split_inclusive('\n') {
        let eol = &line[line.trim_end_matches(['\r', '\n']).len()..];
        if line.starts_with("name: ") {
            out.push_str(&format!("name: {DEV_BUNDLED_SKILL_NAME}{eol}"));
        } else if line.starts_with("description: ") {
            out.push_str(&format!(
                "description: Inspect and safely update the preferences of Atlas Dev (a source \
                 build of Atlas, run with `bun run dev:app`) through its own config.toml.{eol}"
            ));
        } else {
            out.push_str(
                &line
                    .replace(&config(Profile::Default), &config(Profile::Dev))
                    .replace(&project_dir(Profile::Default), &project_dir(Profile::Dev)),
            );
            if !noted && line.starts_with("# ") {
                noted = true;
                out.push_str(&format!(
                    "{eol}> This copy is for **Atlas Dev**, a source build of Atlas (`bun run \
                     dev:app`) that keeps its own data beside an installed Atlas. It edits Atlas \
                     Dev's file, named below. The installed Atlas's `{installed_config}` is not \
                     Atlas Dev's: leave it alone.{eol}"
                ));
            }
        }
    }
    (DEV_BUNDLED_SKILL_NAME, Cow::Owned(out))
}

/// Sidecar file recording the hash of the bundled content Atlas itself last
/// wrote, so a later upgrade can tell "the user never touched this" (safe to
/// overwrite with the new bundled version) apart from "the user edited this"
/// (must not clobber their changes — surface drift instead).
const BUNDLED_HASH_FILE: &str = ".bundled-hash";

fn sha256_hex(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(content.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Install or upgrade every bundled skill ([`BUNDLED_SKILLS`]) into the
/// canonical **global** store (`~/.agents/skills/<name>`), so each is
/// discoverable through the exact same `list_skills`/`skills_project`
/// machinery as any other managed skill — no second delivery path.
///
/// Idempotent and safe to call on every launch:
/// - Missing entirely → write it fresh.
/// - Present, and its content hash matches the last hash *this function*
///   recorded → the user never touched it since; safe to overwrite with
///   whatever this build ships (a normal version upgrade).
/// - Present, but the hash doesn't match (or the sidecar is missing/
///   unreadable) → treat as user-modified and leave it alone entirely,
///   including not touching the sidecar, so the next launch keeps re-
///   detecting the drift rather than adopting the user's edit as "new
///   baseline" behind their back.
///
/// Global-only, matching the design record: no per-project duplicate. A
/// skill's first install also links it into the installed tools that read
/// only their own folder ([`link_bundled_skill`]); after that, its projections
/// are the user's, as for any other skill.
///
/// The dev profile seeds its own self-configure copy,
/// `atlas-dev-self-configure`, beside the installed Atlas's, and never
/// overwrites a skill the installed Atlas seeds: see [`bundled_skill`].
pub fn sync_bundled_skills(home: &Path, profile: atlas_profile::Profile, config_file: &str) {
    ensure_bundled_skills_at(home, profile, config_file);
}

/// [`sync_bundled_skills`] under its original name, which the tests below
/// call: the root, the profile and the config file's name are all parameters,
/// so a test points it at a temp dir instead of the real `$HOME`.
fn ensure_bundled_skills_at(root: &Path, profile: atlas_profile::Profile, config_file: &str) {
    for skill in BUNDLED_SKILLS {
        let (name, content) = bundled_skill(skill, profile, config_file);
        // A skill both builds seed under one name lives in the shared store;
        // the dev profile only installs it when missing, so it never
        // overwrites the installed Atlas's copy (and the two builds never
        // take turns rewriting it on every launch).
        let shared = profile.is_dev() && name == skill.name;
        if shared && skills_base(root).join(name).join("SKILL.md").exists() {
            continue;
        }
        // A copy only this profile seeds (Atlas Dev's self-configure) stays out
        // of the tools' own folders: Claude Code and Codex read those for every
        // session on the machine, the installed Atlas's included.
        let link = name == skill.name;
        ensure_bundled_skill_at(root, name, &content, link);
    }
}

/// Seed one bundled skill under `root` (see [`sync_bundled_skills`]).
fn ensure_bundled_skill_at(root: &Path, name: &str, content: &str, link: bool) {
    let dir = skills_base(root).join(name);
    let skill_md = dir.join("SKILL.md");
    let hash_file = dir.join(BUNDLED_HASH_FILE);
    let bundled_hash = sha256_hex(content);
    let fresh = !skill_md.exists();

    if !fresh {
        let recorded_hash = fs::read_to_string(&hash_file).ok();
        let on_disk_matches_recorded = fs::read_to_string(&skill_md)
            .ok()
            .zip(recorded_hash.as_deref())
            .map(|(disk, recorded)| sha256_hex(&disk) == recorded.trim())
            .unwrap_or(false);
        if !on_disk_matches_recorded {
            // User-modified (or a pre-#64 install with no sidecar yet) —
            // never overwrite silently.
            return;
        }
    }

    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if atlas_fs::replace_file(&skill_md, content).is_ok() {
        let _ = atlas_fs::replace_file(&hash_file, &bundled_hash);
        if fresh && link {
            link_bundled_skill(root, name);
        }
    }
}

/// Tools a bundled skill is linked into when it is first installed. Each reads
/// only its own skills folder, so a skill seeded into the canonical store
/// alone is invisible to them: Claude Code would never offer `/remember`.
const BUNDLED_SKILL_TOOLS: &[&str] = &["claude-code", "codex"];

/// Project a just-installed bundled skill into every detected tool in
/// [`BUNDLED_SKILL_TOOLS`], through the ordinary [`project`] so the ledger
/// records it like any skill the user linked. Only on first install: a user
/// who later unlinks it keeps it unlinked across launches. A tool that already
/// has an entry of that name (the user's own skill, or a link of theirs) is
/// left alone.
fn link_bundled_skill(root: &Path, name: &str) {
    for id in BUNDLED_SKILL_TOOLS {
        let Some(def) = tool_def(id) else { continue };
        if !tool_detected(root, def) || tool_has_entry(root, def, "global", name) {
            continue;
        }
        let _ = project(root, def, "global", name, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::parse_frontmatter;
    use crate::ledger::read_ledger;
    use crate::library::list_skills;
    use crate::paths::sanitize_name;
    use crate::projection::unproject;
    use crate::registry::tool_link_path;
    use crate::test_support::{tmp_root_isolated, tool_env_overridden};

    /// The app's `CONFIG_FILE_NAME`, which it passes in.
    const CONFIG_FILE: &str = "config.toml";

    #[test]
    fn every_bundled_skill_is_installed_fresh_into_the_canonical_store() {
        let root = tmp_root_isolated();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        for skill in BUNDLED_SKILLS {
            let dir = skills_base(&root).join(skill.name);
            let installed = fs::read_to_string(dir.join("SKILL.md")).unwrap();
            assert_eq!(installed, skill.skill_md);

            let recorded_hash = fs::read_to_string(dir.join(BUNDLED_HASH_FILE)).unwrap();
            assert_eq!(recorded_hash.trim(), sha256_hex(skill.skill_md));
        }
        let self_configure =
            fs::read_to_string(skills_base(&root).join("atlas-self-configure/SKILL.md")).unwrap();
        assert!(self_configure.contains("name: atlas-self-configure"));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_fresh_bundled_skill_is_linked_into_every_detected_tool() {
        if tool_env_overridden() {
            return;
        }
        let root = tmp_root_isolated();
        // Claude Code is installed, Codex is not.
        fs::create_dir_all(root.join(".claude")).unwrap();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        let claude = tool_def("claude-code").unwrap();
        let codex = tool_def("codex").unwrap();
        let ledger = read_ledger(&root);
        for skill in BUNDLED_SKILLS {
            let link = tool_link_path(&root, claude, "global", skill.name);
            assert_eq!(
                fs::read_to_string(link.join("SKILL.md")).unwrap(),
                skill.skill_md
            );
            assert!(ledger
                .projections
                .get(skill.name)
                .is_some_and(|per_tool| per_tool.contains_key(claude.id)));
            assert!(!tool_has_entry(&root, codex, "global", skill.name));
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unlinked_bundled_skill_stays_unlinked_on_the_next_launch() {
        if tool_env_overridden() {
            return;
        }
        let root = tmp_root_isolated();
        fs::create_dir_all(root.join(".claude")).unwrap();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);
        let claude = tool_def("claude-code").unwrap();
        unproject(&root, claude, "global", REMEMBER.name).unwrap();

        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        assert!(!tool_has_entry(&root, claude, "global", REMEMBER.name));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn linking_leaves_a_tools_own_skill_of_that_name_alone() {
        if tool_env_overridden() {
            return;
        }
        let root = tmp_root_isolated();
        let claude = tool_def("claude-code").unwrap();
        let own = tool_link_path(&root, claude, "global", REMEMBER.name);
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("SKILL.md"), "the user's own remember").unwrap();

        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        assert!(!own.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(own.join("SKILL.md")).unwrap(),
            "the user's own remember"
        );
        fs::remove_dir_all(&root).ok();
    }

    /// An agent advertises a skill by its frontmatter `name`, and the store
    /// keys it by directory: the two must agree, or the picker row and the
    /// seeded directory name different things. The name must also survive
    /// [`sanitize_name`] unchanged, since every other store path goes
    /// through it.
    #[test]
    fn every_bundled_skill_names_itself_by_its_directory() {
        let mut seen = std::collections::HashSet::new();
        for skill in BUNDLED_SKILLS {
            assert!(seen.insert(skill.name), "{} is bundled twice", skill.name);
            assert_eq!(sanitize_name(skill.name).as_deref(), Ok(skill.name));
            let (fm, body) = parse_frontmatter(skill.skill_md);
            assert_eq!(fm.name.as_deref(), Some(skill.name));
            assert!(
                fm.description.is_some_and(|d| !d.trim().is_empty()),
                "{} has no description",
                skill.name
            );
            assert!(!body.trim().is_empty(), "{} has no body", skill.name);
        }
    }

    /// The `remember` skill is what save-before-switch relies on: it has to
    /// name the memory tools as `atlas_memory` serves them, keep the exit for
    /// an agent without them, and say its own instructions are not memory.
    #[test]
    fn the_remember_skill_names_the_memory_tools_and_its_exits() {
        let md = REMEMBER.skill_md;
        assert!(md.contains("`memory_remember` tool from the `atlas_memory` MCP server"));
        assert!(md.contains("`memory_search`"));
        for kind in ["decision", "fact", "failure", "architecture"] {
            assert!(md.contains(&format!("- `{kind}`:")), "missing kind {kind}");
        }
        assert!(md.contains("aren't available to you, say so and stop"));
        assert!(md.contains("they are not something the user decided, so don't record them"));
    }

    #[test]
    fn bundled_skill_appears_as_a_managed_global_skill() {
        let root = tmp_root_isolated();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        let skills = list_skills(&root, "global").expect("list_skills succeeds");
        for bundled in BUNDLED_SKILLS {
            let entry = skills
                .iter()
                .find(|s| s.name == bundled.name)
                .unwrap_or_else(|| panic!("{} is discoverable", bundled.name));
            assert!(entry.managed);
            assert_eq!(entry.scope, "global");
        }

        fs::remove_dir_all(&root).ok();
    }

    /// Issue #64's acceptance criteria name the skill's *projection*, not just
    /// its discoverability: "a managed global `self-configure` skill is
    /// available for supported Atlas agents". Discoverability was covered;
    /// actually landing it in a tool's skills dir was not.
    #[test]
    fn bundled_skill_projects_into_a_supported_tool() {
        let root = tmp_root_isolated();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        for skill in BUNDLED_SKILLS {
            for tool in ["claude-code", "codex"] {
                let def = tool_def(tool).expect("tool is in the registry");
                project(&root, def, "global", skill.name, false).unwrap_or_else(|e| {
                    panic!("projecting {} into {tool} failed: {e}", skill.name)
                });

                let link = tool_link_path(&root, def, "global", skill.name);
                let projected = fs::read_to_string(link.join("SKILL.md")).unwrap_or_else(|e| {
                    panic!("{tool} projection of {} has no SKILL.md: {e}", skill.name)
                });
                assert_eq!(projected, skill.skill_md);

                // And the ledger knows about it, which is what `reconcile` reads
                // to report the skill as projected rather than as external drift.
                let ledger = read_ledger(&root);
                assert!(
                    ledger
                        .projections
                        .get(skill.name)
                        .is_some_and(|per_tool| per_tool.contains_key(def.id)),
                    "{tool} projection of {} was not recorded in the ledger",
                    skill.name
                );
            }
        }

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reinstalling_is_idempotent_when_nothing_touched_it() {
        let root = tmp_root_isolated();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);
        let dir = skills_base(&root).join(ATLAS_SELF_CONFIGURE.name);
        let first_pass = fs::read_to_string(dir.join("SKILL.md")).unwrap();

        // Simulates the next app launch on the same (unmodified) install.
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);
        let second_pass = fs::read_to_string(dir.join("SKILL.md")).unwrap();

        assert_eq!(first_pass, second_pass);
        fs::remove_dir_all(&root).ok();
    }

    /// The upgrade half of the contract: a copy Atlas wrote and nobody
    /// touched is replaced by what the new build ships.
    #[test]
    fn an_untouched_skill_is_upgraded_to_the_new_bundled_content() {
        let root = tmp_root_isolated();
        let old = BundledSkill {
            name: REMEMBER.name,
            skill_md: "---\nname: remember\ndescription: old\n---\n\nold body\n",
        };
        ensure_bundled_skill_at(&root, old.name, old.skill_md, true);
        let dir = skills_base(&root).join(REMEMBER.name);
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            old.skill_md
        );

        ensure_bundled_skill_at(&root, REMEMBER.name, REMEMBER.skill_md, true);

        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            REMEMBER.skill_md
        );
        assert_eq!(
            fs::read_to_string(dir.join(BUNDLED_HASH_FILE)).unwrap(),
            sha256_hex(REMEMBER.skill_md)
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_user_edited_skill_is_never_silently_overwritten() {
        let root = tmp_root_isolated();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        // The user (or an agent, via the ordinary skills-edit surface) hand-
        // edits the canonical copy — its hash no longer matches the sidecar.
        for skill in BUNDLED_SKILLS {
            let skill_md = skills_base(&root).join(skill.name).join("SKILL.md");
            fs::write(&skill_md, "user-modified content").unwrap();
        }

        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        for skill in BUNDLED_SKILLS {
            let skill_md = skills_base(&root).join(skill.name).join("SKILL.md");
            assert_eq!(
                fs::read_to_string(&skill_md).unwrap(),
                "user-modified content"
            );
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_skill_with_no_hash_sidecar_is_treated_as_user_owned() {
        // Covers a pre-#64 install (or any external drop-in) that has a
        // SKILL.md at this exact canonical path but no `.bundled-hash` —
        // absence of the sidecar must fail closed (never overwrite), not
        // open. For `remember`, that is also a user's own skill of that name.
        let root = tmp_root_isolated();
        for skill in BUNDLED_SKILLS {
            let dir = skills_base(&root).join(skill.name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "hand-authored, no sidecar").unwrap();
        }

        ensure_bundled_skills_at(&root, atlas_profile::Profile::Default, CONFIG_FILE);

        for skill in BUNDLED_SKILLS {
            let dir = skills_base(&root).join(skill.name);
            assert_eq!(
                fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                "hand-authored, no sidecar"
            );
            assert!(!dir.join(BUNDLED_HASH_FILE).exists());
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_default_profile_seeds_the_shipped_text_byte_for_byte() {
        let (name, content) = bundled_skill(
            &ATLAS_SELF_CONFIGURE,
            atlas_profile::Profile::Default,
            CONFIG_FILE,
        );
        assert_eq!(name, ATLAS_SELF_CONFIGURE.name);
        assert_eq!(content, ATLAS_SELF_CONFIGURE.skill_md);
    }

    /// Atlas Dev's copy points an agent at Atlas Dev's config, never at the
    /// installed Atlas's, and is otherwise the shipped text, so a change to
    /// the skill can be tried under `dev:app`.
    #[test]
    fn the_dev_profile_skill_points_at_the_dev_config() {
        let (name, dev) = bundled_skill(
            &ATLAS_SELF_CONFIGURE,
            atlas_profile::Profile::Dev,
            CONFIG_FILE,
        );
        assert_eq!(name, DEV_BUNDLED_SKILL_NAME);
        assert_ne!(name, ATLAS_SELF_CONFIGURE.name);
        assert!(dev.contains("name: atlas-dev-self-configure\n"));
        assert!(dev.contains("~/.config/atlas-dev/config.toml"));
        assert!(dev.contains("$XDG_CONFIG_HOME/atlas-dev/config.toml"));
        assert!(dev.contains("per-project `.atlas-dev/` state"));
        // The installed Atlas's path survives only in the note that says to
        // leave it alone.
        let outside_note: String = dev
            .lines()
            .filter(|l| !l.starts_with("> This copy is for **Atlas Dev**"))
            .collect();
        assert!(!outside_note.contains("/atlas/config.toml"), "{dev}");
        assert!(!outside_note.contains("`.atlas/`"), "{dev}");
        // Everything else is the shipped skill: the same body, line for line,
        // once the dev paths are mapped back.
        let mapped_back = outside_note
            .replace("/atlas-dev/config.toml", "/atlas/config.toml")
            .replace("`.atlas-dev/`", "`.atlas/`");
        let shipped: String = ATLAS_SELF_CONFIGURE.skill_md.lines().collect();
        let strip_frontmatter = |s: &str| s.split("---").nth(2).unwrap_or_default().to_string();
        assert_eq!(strip_frontmatter(&mapped_back), strip_frontmatter(&shipped));
    }

    /// Atlas Dev's own self-configure copy is never linked into the tools'
    /// folders, which every Claude Code / Codex session on the machine reads.
    #[test]
    fn the_dev_profile_skill_is_not_linked_into_tools() {
        let root = tmp_root_isolated();
        for id in BUNDLED_SKILL_TOOLS {
            let def = tool_def(id).unwrap();
            fs::create_dir_all(root.join(def.config_dir)).unwrap();
        }
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Dev, CONFIG_FILE);
        for id in BUNDLED_SKILL_TOOLS {
            let def = tool_def(id).unwrap();
            assert!(
                !tool_has_entry(&root, def, "global", DEV_BUNDLED_SKILL_NAME),
                "{id}"
            );
        }
        fs::remove_dir_all(&root).ok();
    }

    /// A skill both builds seed under one name (`remember`) is installed by
    /// the dev profile only when missing. Overwriting it would rewrite the
    /// installed Atlas's copy, and the two builds would take turns doing so.
    #[test]
    fn the_dev_profile_never_overwrites_a_shared_skill() {
        let root = tmp_root_isolated();
        let remember = skills_base(&root).join(REMEMBER.name).join("SKILL.md");

        ensure_bundled_skills_at(&root, atlas_profile::Profile::Dev, CONFIG_FILE);
        assert_eq!(fs::read_to_string(&remember).unwrap(), REMEMBER.skill_md);

        // The installed Atlas shipped a different version, untouched since.
        fs::write(&remember, "installed version").unwrap();
        fs::write(
            remember.with_file_name(BUNDLED_HASH_FILE),
            sha256_hex("installed version"),
        )
        .unwrap();
        ensure_bundled_skills_at(&root, atlas_profile::Profile::Dev, CONFIG_FILE);
        assert_eq!(fs::read_to_string(&remember).unwrap(), "installed version");
        fs::remove_dir_all(&root).ok();
    }

    /// The two copies live side by side in the shared store, and seeding one
    /// never writes the other.
    #[test]
    fn the_dev_profile_never_writes_the_installed_atlas_copy() {
        use atlas_profile::Profile;
        let root = tmp_root_isolated();
        let installed = skills_base(&root).join(ATLAS_SELF_CONFIGURE.name);
        let dev = skills_base(&root).join(DEV_BUNDLED_SKILL_NAME);

        ensure_bundled_skills_at(&root, Profile::Dev, CONFIG_FILE);
        assert!(!installed.exists(), "seeded the installed Atlas's skill");
        let (_, dev_md) = bundled_skill(&ATLAS_SELF_CONFIGURE, Profile::Dev, CONFIG_FILE);
        assert_eq!(fs::read_to_string(dev.join("SKILL.md")).unwrap(), dev_md);
        assert_eq!(
            fs::read_to_string(dev.join(BUNDLED_HASH_FILE)).unwrap(),
            sha256_hex(&dev_md)
        );

        ensure_bundled_skills_at(&root, Profile::Default, CONFIG_FILE);
        let installed_md = fs::read_to_string(installed.join("SKILL.md")).unwrap();
        assert_eq!(installed_md, ATLAS_SELF_CONFIGURE.skill_md);

        // Launches alternate; neither copy moves.
        ensure_bundled_skills_at(&root, Profile::Dev, CONFIG_FILE);
        ensure_bundled_skills_at(&root, Profile::Default, CONFIG_FILE);
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            ATLAS_SELF_CONFIGURE.skill_md
        );
        assert_eq!(fs::read_to_string(dev.join("SKILL.md")).unwrap(), dev_md);

        let listed = list_skills(&root, "global").unwrap();
        for name in [ATLAS_SELF_CONFIGURE.name, DEV_BUNDLED_SKILL_NAME] {
            assert!(listed.iter().any(|s| s.name == name && s.managed), "{name}");
        }
        fs::remove_dir_all(&root).ok();
    }
}
