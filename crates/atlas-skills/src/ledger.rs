//! The projection ledger: which skill is projected into which tool, and how.

use crate::disk::atomic_write;
use crate::model::ComponentKind;
use crate::paths::skills_base;
use crate::registry::ATLAS_TOOL_ID;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ── Projection ledger (CP.3) ─────────────────────────────────────────────────────

/// One recorded projection of a skill into a tool: how it was materialized and
/// the canonical hash at push time (for drift detection on copies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LedgerEntry {
    /// `"symlink"` | `"copy"` | `"native"` (the tool's own skills dir IS the
    /// canonical store at this scope — see [`project`]'s native-location guard).
    pub(crate) mode: String,
    /// Canonical content hash at the moment of projection.
    pub(crate) hash: String,
    /// Which component kind this entry projected. Defaults to `Skill` and is
    /// omitted from JSON when it *is* `Skill`, so pre-existing skill-only ledgers
    /// round-trip byte-identically.
    #[serde(default, skip_serializing_if = "is_skill_kind")]
    pub(crate) component_kind: ComponentKind,
}

/// `skip_serializing_if` predicate: a `Skill` kind is the implicit default and is
/// never written to the ledger JSON.
// The reference is serde's contract for `skip_serializing_if`, not a choice.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_skill_kind(kind: &ComponentKind) -> bool {
    *kind == ComponentKind::Skill
}

/// `<root>/.agents/skills/.projections.json` — one ledger per root (home for
/// global, project for project). Map: skill → toolId → entry.
///
/// The ledger is shared by the installed Atlas and Atlas Dev, but the native
/// agent's row is not: its skills dir is `~/.atlas/agent-skills` in one and
/// `~/.atlas-dev/agent-skills` in the other. So Atlas Dev keeps its row under
/// [`DEV_ATLAS_LEDGER_KEY`] on disk, sees it as the tool's own id in memory,
/// and carries the installed Atlas's row through untouched
/// ([`ledger_after_read`], [`ledger_for_write`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Ledger {
    pub(crate) version: u32,
    pub(crate) projections: BTreeMap<String, BTreeMap<String, LedgerEntry>>,
    /// The other profile's native-agent rows, set aside on read and written
    /// back as they were. Never serialized under this name.
    #[serde(skip)]
    pub(crate) other_profile: BTreeMap<String, LedgerEntry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: 1,
            projections: BTreeMap::new(),
            other_profile: BTreeMap::new(),
        }
    }
}

/// Atlas Dev's native-agent row on disk. Unknown to the installed Atlas, which
/// skips tool ids it has no definition for.
const DEV_ATLAS_LEDGER_KEY: &str = "atlas-dev";

/// The ledger as `profile` sees it (see [`Ledger`]).
fn ledger_after_read(mut ledger: Ledger, profile: atlas_profile::Profile) -> Ledger {
    if !profile.is_dev() {
        return ledger;
    }
    let Ledger {
        projections,
        other_profile,
        ..
    } = &mut ledger;
    for (skill, tools) in projections.iter_mut() {
        if let Some(installed) = tools.remove(ATLAS_TOOL_ID) {
            other_profile.insert(skill.clone(), installed);
        }
        if let Some(dev) = tools.remove(DEV_ATLAS_LEDGER_KEY) {
            tools.insert(ATLAS_TOOL_ID.to_string(), dev);
        }
    }
    projections.retain(|_, tools| !tools.is_empty());
    ledger
}

/// The ledger as `profile` writes it: the inverse of [`ledger_after_read`].
fn ledger_for_write(ledger: &Ledger, profile: atlas_profile::Profile) -> Ledger {
    let mut out = ledger.clone();
    if !profile.is_dev() {
        return out;
    }
    for tools in out.projections.values_mut() {
        if let Some(dev) = tools.remove(ATLAS_TOOL_ID) {
            tools.insert(DEV_ATLAS_LEDGER_KEY.to_string(), dev);
        }
    }
    for (skill, installed) in &ledger.other_profile {
        out.projections
            .entry(skill.clone())
            .or_default()
            .insert(ATLAS_TOOL_ID.to_string(), installed.clone());
    }
    out
}

fn ledger_path(root: &Path) -> PathBuf {
    skills_base(root).join(".projections.json")
}

/// Read the ledger, tolerating a missing or garbage file (→ default empty).
pub(crate) fn read_ledger(root: &Path) -> Ledger {
    let path = ledger_path(root);
    let ledger = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Ledger::default(),
    };
    ledger_after_read(ledger, atlas_profile::current())
}

/// Atomically persist the ledger (reuses [`atomic_write`]).
pub(crate) fn write_ledger(root: &Path, ledger: &Ledger) -> Result<(), String> {
    let on_disk = ledger_for_write(ledger, atlas_profile::current());
    let payload = serde_json::to_string_pretty(&on_disk).map_err(|e| e.to_string())?;
    atomic_write(&ledger_path(root), &payload)
}

pub(crate) fn ledger_record(
    ledger: &mut Ledger,
    safe_name: &str,
    tool_id: &str,
    mode: &str,
    hash: &str,
) {
    ledger
        .projections
        .entry(safe_name.to_string())
        .or_default()
        .insert(
            tool_id.to_string(),
            LedgerEntry {
                mode: mode.to_string(),
                hash: hash.to_string(),
                component_kind: ComponentKind::Skill,
            },
        );
}

pub(crate) fn ledger_remove(ledger: &mut Ledger, safe_name: &str, tool_id: &str) {
    if let Some(tools) = ledger.projections.get_mut(safe_name) {
        tools.remove(tool_id);
        if tools.is_empty() {
            ledger.projections.remove(safe_name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::tool_def;

    #[test]
    fn component_kind_defaults_to_skill() {
        assert_eq!(ComponentKind::default(), ComponentKind::Skill);
        assert!(is_skill_kind(&ComponentKind::default()));
        assert!(!is_skill_kind(&ComponentKind::Agent));
    }

    #[test]
    fn skill_ledger_entry_round_trips_without_component_kind_key() {
        // A skill entry omits the kind key entirely → byte-compatible with the
        // pre-Phase-0 ledger format.
        let entry = LedgerEntry {
            mode: "symlink".to_string(),
            hash: "abc123".to_string(),
            component_kind: ComponentKind::Skill,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(
            !json.contains("component_kind"),
            "skill entry must not write the kind: {json}"
        );

        // A non-skill entry writes the kind, and both directions round-trip.
        let agent_entry = LedgerEntry {
            mode: "copy".to_string(),
            hash: "deadbeef".to_string(),
            component_kind: ComponentKind::Agent,
        };
        let agent_json = serde_json::to_string(&agent_entry).unwrap();
        assert!(
            agent_json.contains("\"component_kind\":\"agent\""),
            "{agent_json}"
        );

        // Legacy JSON with no kind key deserializes back to Skill.
        let legacy: LedgerEntry = serde_json::from_str(r#"{"mode":"symlink","hash":"x"}"#).unwrap();
        assert_eq!(legacy.component_kind, ComponentKind::Skill);
    }

    /// Each build sees only its own native-agent row in the shared ledger,
    /// and writing it never disturbs the other build's.
    #[test]
    fn each_profile_keeps_its_own_native_agent_ledger_row() {
        use atlas_profile::Profile;
        let mut on_disk = Ledger::default();
        ledger_record(&mut on_disk, "s", ATLAS_TOOL_ID, "symlink", "installed");
        ledger_record(&mut on_disk, "s", "codex", "symlink", "shared");

        // Atlas Dev has no row of its own yet, and keeps the shared ones.
        let mut dev = ledger_after_read(on_disk.clone(), Profile::Dev);
        assert!(!dev.projections["s"].contains_key(ATLAS_TOOL_ID));
        assert_eq!(dev.projections["s"]["codex"].hash, "shared");

        ledger_record(&mut dev, "s", ATLAS_TOOL_ID, "symlink", "dev");
        let written = ledger_for_write(&dev, Profile::Dev);
        assert_eq!(written.projections["s"][ATLAS_TOOL_ID].hash, "installed");
        assert_eq!(written.projections["s"][DEV_ATLAS_LEDGER_KEY].hash, "dev");

        // The installed Atlas reads its own row back; the dev one is an
        // unknown tool id to it.
        let installed = ledger_after_read(written.clone(), Profile::Default);
        assert_eq!(installed.projections["s"][ATLAS_TOOL_ID].hash, "installed");
        assert!(tool_def(DEV_ATLAS_LEDGER_KEY).is_none());
        // And Atlas Dev reads its own row back as the tool's id.
        let dev_again = ledger_after_read(written, Profile::Dev);
        assert_eq!(dev_again.projections["s"][ATLAS_TOOL_ID].hash, "dev");
    }
}
