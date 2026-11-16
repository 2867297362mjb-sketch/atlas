//! Reconcile: the skill x tool matrix for one scope.

use crate::disk::hash_skill_dir;
use crate::frontmatter::parse_frontmatter;
use crate::ledger::read_ledger;
use crate::library::pack_provided_skills;
use crate::packs::projection::read_pack_proj;
use crate::paths::{migrate_legacy_skills, sanitize_name, skills_base};
use crate::projection::pack_owner_of_skill;
use crate::registry::{tool_detected, tool_link_path, tool_skills_dir, TOOL_REGISTRY};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

// ── Reconcile (CP.1 Job 2) ───────────────────────────────────────────────────────

/// A tool's registry facts for the reconciled view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub display_name: String,
    pub detected_global: bool,
    pub detected_project: bool,
    pub supports_symlink: bool,
    pub delivery: String,
}

/// One cell of the skill × tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionCell {
    pub tool: String,
    /// `"global"` | `"project"`.
    pub scope: String,
    /// `canonical` | `synced` | `drifted` | `external` | `conflict` | `absent`.
    pub status: String,
    /// `"symlink"` | `"copy"` | `null`.
    pub mode: Option<String>,
    /// When this cell's on-disk projection is owned by an installed pack (per the
    /// pack-projection ledger), the owning pack name. Such cells are read-only
    /// from the Skills side — manage them in the Packs tab. `None` otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
}

/// One reconciled skill row: its canonical facts plus the per-tool matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledSkill {
    pub name: String,
    pub description: String,
    /// The scope this row was reconciled at.
    pub scope: String,
    pub managed: bool,
    /// Set when this skill is provided by an installed pack (origin badge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    pub cells: Vec<ProjectionCell>,
}

/// The full reconciled view for one scope+root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileView {
    pub tools: Vec<ToolInfo>,
    pub skills: Vec<ReconciledSkill>,
}

/// Build the reconciled matrix for `scope`. `home` is always needed for global
/// detection facts even when reconciling a project scope.
pub(crate) fn reconcile(root: &Path, scope: &str, home: &Path) -> Result<ReconcileView, String> {
    // Same one-time legacy migration as `list_skills` — reconcile is a discovery
    // entry point too and is called independently of the list view.
    migrate_legacy_skills(root);

    let tools: Vec<ToolInfo> = TOOL_REGISTRY
        .iter()
        .map(|def| ToolInfo {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            detected_global: tool_detected(home, def),
            detected_project: scope == "project" && tool_detected(root, def),
            supports_symlink: def.supports_symlink,
            delivery: def.delivery.to_string(),
        })
        .collect();

    let ledger = read_ledger(root);
    let pack_proj = read_pack_proj(root);
    let base = skills_base(root);

    // Names: canonical dirs ∪ external dirs ∪ pack-provided skills at this scope.
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut canonical_meta: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (display, desc)
    let mut canonical_hash: BTreeMap<String, String> = BTreeMap::new();
    let mut pack_meta: BTreeMap<String, (String, String)> = BTreeMap::new(); // name → (display, desc)
    let mut pack_origin: BTreeMap<String, String> = BTreeMap::new(); // name → pack

    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _b) = parse_frontmatter(&raw);
            canonical_meta.insert(
                safe.clone(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                ),
            );
            canonical_hash.insert(safe.clone(), hash_skill_dir(&entry.path()));
            names.insert(safe);
        }
    }

    // Pre-scan external/real dirs per tool (name → (display, desc, hash)).
    // Follows symlinks (ADR 0005) same as `list_skills`'s external scan.
    let mut external: BTreeMap<String, BTreeMap<String, (String, String, String)>> =
        BTreeMap::new();
    for def in TOOL_REGISTRY.iter() {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            if !entry.path().join("SKILL.md").is_file() {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe) = sanitize_name(&raw_name) else {
                continue;
            };
            let raw = fs::read_to_string(entry.path().join("SKILL.md")).unwrap_or_default();
            let (fm, _b) = parse_frontmatter(&raw);
            external.entry(safe.clone()).or_default().insert(
                def.id.to_string(),
                (
                    fm.name.unwrap_or_else(|| safe.clone()),
                    fm.description.unwrap_or_default(),
                    hash_skill_dir(&entry.path()),
                ),
            );
            names.insert(safe);
        }
    }

    // Pack-provided skills: surface them as rows too (managed = false, with a
    // pack origin) so they appear in My Skills even before being projected.
    for (pack_name, safe, md) in pack_provided_skills(root) {
        names.insert(safe.clone());
        pack_origin.entry(safe.clone()).or_insert(pack_name);
        if !canonical_meta.contains_key(&safe) && !pack_meta.contains_key(&safe) {
            if let Ok(raw) = fs::read_to_string(&md) {
                let (fm, _b) = parse_frontmatter(&raw);
                pack_meta.insert(
                    safe.clone(),
                    (
                        fm.name.unwrap_or_else(|| safe.clone()),
                        fm.description.unwrap_or_default(),
                    ),
                );
            }
        }
    }

    let mut skills: Vec<ReconciledSkill> = Vec::new();
    for name in &names {
        let managed = canonical_meta.contains_key(name);
        let (display, desc) = if let Some((d, e)) = canonical_meta.get(name) {
            (d.clone(), e.clone())
        } else if let Some((d, e)) = pack_meta.get(name) {
            (d.clone(), e.clone())
        } else {
            // Fall back to any external tool's metadata.
            external
                .get(name)
                .and_then(|m| m.values().next())
                .map(|(d, e, _)| (d.clone(), e.clone()))
                .unwrap_or_else(|| (name.clone(), String::new()))
        };
        let canon_hash = canonical_hash.get(name).cloned();

        let mut cells: Vec<ProjectionCell> = Vec::new();
        for def in TOOL_REGISTRY.iter() {
            let link = tool_link_path(root, def, scope, name);
            let entry_meta = link.symlink_metadata().ok();
            let is_symlink = entry_meta
                .as_ref()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            let is_real_dir = entry_meta
                .as_ref()
                .map(|m| !m.file_type().is_symlink() && m.is_dir())
                .unwrap_or(false);
            let ledger_entry = ledger.projections.get(name).and_then(|t| t.get(def.id));

            let (status, mode) = if is_symlink {
                // A symlink projection always reflects canonical (it IS the file).
                ("synced".to_string(), Some("symlink".to_string()))
            } else if is_real_dir {
                let on_disk = hash_skill_dir(&link);
                if managed {
                    // Copy of a canonical skill → synced/drifted by hash.
                    match &canon_hash {
                        Some(h) if &on_disk == h => {
                            ("synced".to_string(), Some("copy".to_string()))
                        }
                        Some(_) => ("drifted".to_string(), Some("copy".to_string())),
                        None => ("drifted".to_string(), Some("copy".to_string())),
                    }
                } else {
                    // No canonical twin → external (or external-conflict).
                    ("external".to_string(), None)
                }
            } else if entry_meta.is_none() {
                // Nothing on disk for this tool.
                ("absent".to_string(), None)
            } else {
                ("absent".to_string(), None)
            };

            // Conflict refinement: an external dir whose name collides with a
            // canonical skill but whose content differs is the dangerous case.
            let status = if status == "external" {
                if let (Some(ext_for_tool), Some(h)) =
                    (external.get(name).and_then(|m| m.get(def.id)), &canon_hash)
                {
                    if &ext_for_tool.2 != h {
                        "conflict".to_string()
                    } else {
                        status
                    }
                } else {
                    status
                }
            } else {
                status
            };

            // Mark the canonical owner cell on a synced-symlink when this tool
            // is the source? No — canonical lives in .atlas, not a tool dir. The
            // `canonical` status belongs to the library row itself, surfaced via
            // `managed`. Leave tool cells as projection statuses.
            let _ = mode; // (mode already set above)
            let mode = match (is_symlink, is_real_dir, ledger_entry) {
                (true, _, _) => Some("symlink".to_string()),
                (_, true, _) => Some("copy".to_string()),
                _ => None,
            };
            // Cross-ledger override: if this on-disk projection is owned by an
            // installed pack, surface it as a read-only `pack` cell so the Skills
            // side won't toggle it (manage it in the Packs tab instead).
            let (status, pack) = match pack_owner_of_skill(root, &pack_proj, def, scope, name) {
                Some(owner) => ("pack".to_string(), Some(owner)),
                None => (status, None),
            };
            cells.push(ProjectionCell {
                tool: def.id.to_string(),
                scope: scope.to_string(),
                status,
                mode,
                pack,
            });
        }

        skills.push(ReconciledSkill {
            name: display,
            description: desc,
            scope: scope.to_string(),
            managed,
            pack: pack_origin.get(name).cloned(),
            cells,
        });
    }

    Ok(ReconcileView { tools, skills })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ComponentKind;
    use crate::packs::projection::project_pack;
    use crate::projection::project;
    use crate::registry::tool_def;
    use crate::test_support::{create_skill, plant_external, root_with_installed_pack, tmp_root};

    #[test]
    fn reconcile_reports_synced_external_and_absent() {
        let root = tmp_root();
        // Canonical skill projected into claude-code → synced. codex's
        // project-scope skills dir IS the canonical store post-convergence
        // (ADR 0005), so it reads synced too without an explicit projection;
        // atlas's dedicated dir is untouched → absent.
        create_skill(&root, "project", "owned", "d", "b", &[]).unwrap();
        project(
            &root,
            tool_def("claude-code").unwrap(),
            "project",
            "owned",
            false,
        )
        .unwrap();
        // A hand-authored skill living only in claude-code's project dir →
        // external. (Planting one in codex's project dir is no longer a
        // distinct "external" case — that dir IS the canonical store now, so
        // anything placed there is ordinary discovery, not reconciliation.)
        plant_external(&root, ".claude/skills", "wild", "External wild");

        let view = reconcile(&root, "project", &root).unwrap();
        assert_eq!(view.tools.len(), 3); // claude-code, codex, atlas

        let owned = view.skills.iter().find(|s| s.name == "owned").unwrap();
        assert!(owned.managed);
        assert_eq!(
            owned
                .cells
                .iter()
                .find(|c| c.tool == "claude-code")
                .unwrap()
                .status,
            "synced"
        );
        assert_eq!(
            owned
                .cells
                .iter()
                .find(|c| c.tool == "codex")
                .unwrap()
                .status,
            "synced"
        );
        assert_eq!(
            owned
                .cells
                .iter()
                .find(|c| c.tool == "atlas")
                .unwrap()
                .status,
            "absent"
        );

        let wild = view.skills.iter().find(|s| s.name == "wild").unwrap();
        assert!(!wild.managed);
        assert_eq!(
            wild.cells
                .iter()
                .find(|c| c.tool == "claude-code")
                .unwrap()
                .status,
            "external"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reconcile_marks_pack_owned_cell() {
        let root = root_with_installed_pack();
        // Pack projects its skill into claude-code → pack ledger owns the target.
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&[ComponentKind::Skill]),
            false,
        )
        .unwrap();
        let view = reconcile(&root, "global", &root).unwrap();
        let foo = view
            .skills
            .iter()
            .find(|s| s.name == "foo")
            .expect("foo row present in reconcile");
        assert_eq!(foo.pack.as_deref(), Some("demo-pack"));
        let cell = foo.cells.iter().find(|c| c.tool == "claude-code").unwrap();
        assert_eq!(cell.status, "pack");
        assert_eq!(cell.pack.as_deref(), Some("demo-pack"));
        fs::remove_dir_all(&root).ok();
    }
}
