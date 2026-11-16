//! The projection engine: a canonical skill placed into (or removed from) a
//! tool's skills directory, and the freeze that turns links into copies.

use crate::disk::{create_copy, create_symlink, hash_skill_dir, remove_symlink};
use crate::ledger::{ledger_record, ledger_remove, read_ledger, write_ledger};
use crate::model::ComponentKind;
use crate::packs::projection::{read_pack_proj, rel_to_root, PackProj};
use crate::paths::{canonical_skill_dir, sanitize_name, skills_base};
use crate::registry::{tool_def, tool_link_path, ToolDef};
use std::path::Path;

/// The pack (if any) that owns the skill projection at `safe_name` for this
/// `tool`/`scope`, per the live pack-projection ledger. The pack records its
/// target as `rel_to_root(root, target)`; the Skills target for the same skill
/// is `tool_link_path(...)`, so the two match when the names sanitize equally.
pub(crate) fn pack_owner_of_skill(
    root: &Path,
    proj: &PackProj,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Option<String> {
    let target_rel = rel_to_root(root, &tool_link_path(root, def, scope, safe_name));
    for (pack, tools) in &proj.projections {
        if let Some(entries) = tools.get(def.id) {
            if entries
                .iter()
                .any(|e| e.kind == ComponentKind::Skill && e.target_rel == target_rel)
            {
                return Some(pack.clone());
            }
        }
    }
    None
}

// ── Projection engine (CP.1 Job 3, CP.3) ─────────────────────────────────────────

/// Project a canonical skill into a tool at a scope. Symlink when the tool
/// `supports_symlink`, else copy fallback. Records mode + canonical hash in the
/// ledger. **Non-destructive**: refuses to clobber a `drifted` copy or an
/// `external` dir unless `force` is set.
pub(crate) fn project(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
    force: bool,
) -> Result<(), String> {
    if def.delivery == "inject-only" {
        return Err(format!(
            "tool {} is inject-only and cannot receive a file projection",
            def.id
        ));
    }
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let canonical_hash = hash_skill_dir(&canonical);
    if canonical_hash.is_empty() || !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }

    let link = tool_link_path(root, def, scope, safe_name);

    // Store convergence (ADR 0005): Codex's own *project*-scope skills dir was
    // already `.agents/skills`, the same path the canonical store now uses, so
    // for that (tool, scope) pair `link` and `canonical` are the same directory.
    // The skill already lives where the tool reads it — nothing to symlink/copy,
    // just record it as projected.
    if link == canonical {
        let mut ledger = read_ledger(root);
        ledger_record(&mut ledger, safe_name, def.id, "native", &canonical_hash);
        return write_ledger(root, &ledger);
    }

    // Non-destructive guard: if a real (non-symlink) dir already sits at the
    // target, only overwrite when the caller forces it.
    if !force {
        if let Ok(meta) = link.symlink_metadata() {
            if !meta.file_type().is_symlink() && meta.is_dir() {
                let existing_hash = hash_skill_dir(&link);
                if existing_hash != canonical_hash {
                    return Err(format!(
                        "refusing to overwrite drifted/external '{safe_name}' in {} (use force)",
                        def.id
                    ));
                }
            }
        }
        // Cross-ledger guard: never silently clobber a projection an installed
        // pack owns. The pack ledger is only read here — Skills never writes it.
        if let Some(owner) = pack_owner_of_skill(root, &read_pack_proj(root), def, scope, safe_name)
        {
            return Err(format!(
                "'{safe_name}' in {} is managed by pack '{owner}' — manage it from the Packs tab (or use force)",
                def.id
            ));
        }
    }

    let mut ledger = read_ledger(root);
    if def.supports_symlink {
        match create_symlink(root, def, scope, safe_name) {
            Ok(()) => {
                ledger_record(&mut ledger, safe_name, def.id, "symlink", &canonical_hash);
            }
            Err(_) => {
                // Symlink syscall failed (e.g. non-Unix) → copy fallback.
                create_copy(root, def, scope, safe_name)?;
                ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
            }
        }
    } else {
        create_copy(root, def, scope, safe_name)?;
        ledger_record(&mut ledger, safe_name, def.id, "copy", &canonical_hash);
    }
    write_ledger(root, &ledger)
}

/// Remove a projection (symlink or copy) and drop its ledger entry. Refuses to
/// act on a native-location pair (see [`project`]) — `clear_entry` would delete
/// the canonical skill itself rather than a projection of it.
pub(crate) fn unproject(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    let link = tool_link_path(root, def, scope, safe_name);
    if link == canonical {
        return Err(format!(
            "cannot disable {} for '{safe_name}': its {scope}-scope skills dir is the canonical store itself",
            def.id
        ));
    }
    remove_symlink(root, def, scope, safe_name)?;
    let mut ledger = read_ledger(root);
    ledger_remove(&mut ledger, safe_name, def.id);
    write_ledger(root, &ledger)
}

// ── Freeze (CP.3 uninstall safety) ───────────────────────────────────────────────

/// Convert every Atlas-authored *symlink* projection in the ledger into a real
/// copy, so removing `~/.agents/skills` leaves each tool with a working,
/// self-contained skill dir. Idempotent (copies are left as-is).
pub(crate) fn freeze(root: &Path, scope: &str) -> Result<(), String> {
    let mut ledger = read_ledger(root);
    let snapshot = ledger.projections.clone();
    for (safe_name, tools) in snapshot {
        for (tool_id, entry) in tools {
            if entry.mode != "symlink" {
                continue;
            }
            let Some(def) = tool_def(&tool_id) else {
                continue;
            };
            let canonical = canonical_skill_dir(&skills_base(root), &safe_name)?;
            if !canonical.join("SKILL.md").is_file() {
                continue; // canonical gone — nothing to freeze from
            }
            let hash = hash_skill_dir(&canonical);
            // Replace the symlink with a real copy of canonical.
            create_copy(root, def, scope, &safe_name)?;
            ledger_record(&mut ledger, &safe_name, &tool_id, "copy", &hash);
        }
    }
    write_ledger(root, &ledger)
}

/// [`project`] by the names the UI sends: the skill's name as typed and the
/// tool's id.
pub(crate) fn project_named(
    root: &Path,
    scope: &str,
    name: &str,
    tool: &str,
    force: bool,
) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    let def = tool_def(tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
    project(root, def, scope, &safe, force)
}

/// [`unproject`] by the names the UI sends.
pub(crate) fn unproject_named(
    root: &Path,
    scope: &str,
    name: &str,
    tool: &str,
) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    let def = tool_def(tool).ok_or_else(|| format!("unknown tool: {tool}"))?;
    unproject(root, def, scope, &safe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::projection::project_pack;
    use crate::test_support::{create_skill, root_with_installed_pack, tmp_root};
    use std::fs;

    #[test]
    fn hash_is_stable_and_detects_change() {
        let root = tmp_root();
        create_skill(&root, "project", "h", "d", "body one", &[]).unwrap();
        let dir = root.join(".agents/skills/h");
        let a = hash_skill_dir(&dir);
        assert_eq!(a, hash_skill_dir(&dir), "hash must be stable");
        create_skill(&root, "project", "h", "d", "body two", &[]).unwrap();
        assert_ne!(a, hash_skill_dir(&dir), "hash must change with content");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_symlinks_records_ledger_then_unproject_clears() {
        let root = tmp_root();
        create_skill(&root, "project", "p", "d", "b", &[]).unwrap();
        let def = tool_def("claude-code").unwrap();

        project(&root, def, "project", "p", false).unwrap();
        let link = root.join(".claude/skills/p");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            read_ledger(&root).projections["p"]["claude-code"].mode,
            "symlink"
        );

        unproject(&root, def, "project", "p").unwrap();
        assert!(link.symlink_metadata().is_err());
        assert!(!read_ledger(&root).projections.contains_key("p"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn freeze_converts_symlink_projection_to_real_copy() {
        let root = tmp_root();
        create_skill(&root, "project", "f", "d", "b", &[]).unwrap();
        project(
            &root,
            tool_def("claude-code").unwrap(),
            "project",
            "f",
            false,
        )
        .unwrap();
        let link = root.join(".claude/skills/f");
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());

        freeze(&root, "project").unwrap();
        let meta = link.symlink_metadata().unwrap();
        assert!(
            !meta.file_type().is_symlink(),
            "freeze must replace the symlink"
        );
        assert!(
            link.join("SKILL.md").is_file(),
            "frozen copy keeps the skill file"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_project_scope_is_native_location_not_a_projection() {
        let root = tmp_root();
        let def = tool_def("codex").unwrap();
        create_skill(&root, "project", "native", "d", "b", &[]).unwrap();

        // Projecting is a no-op success recorded as "native" in the ledger —
        // there is nothing to symlink, the skill already lives where codex reads.
        project(&root, def, "project", "native", false).unwrap();
        assert_eq!(
            read_ledger(&root).projections["native"]["codex"].mode,
            "native"
        );
        assert!(
            root.join(".agents/skills/native")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_dir(),
            "must stay a real dir, never become a self-referential symlink"
        );

        // Unprojecting must refuse rather than delete the canonical skill.
        assert!(unproject(&root, def, "project", "native").is_err());
        assert!(root.join(".agents/skills/native/SKILL.md").is_file());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_refuses_pack_owned_target_without_force() {
        let root = root_with_installed_pack();
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&[ComponentKind::Skill]),
            false,
        )
        .unwrap();
        // Author a canonical skill of the same name (no projection yet).
        create_skill(&root, "global", "foo", "authored", "body", &[]).unwrap();
        let def = tool_def("claude-code").unwrap();
        // Without force: refused because the pack owns claude-code/foo.
        let err = project(&root, def, "global", "foo", false).unwrap_err();
        assert!(err.contains("managed by pack"), "got: {err}");
        // With force: the Skills side may take over.
        assert!(project(&root, def, "global", "foo", true).is_ok());
        fs::remove_dir_all(&root).ok();
    }
}
