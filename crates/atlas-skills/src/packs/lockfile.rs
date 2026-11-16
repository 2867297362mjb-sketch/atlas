//! The pack lockfile and the pack store's directory guard.

use crate::disk::atomic_write;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

// ── Pack lockfile (`<root>/.atlas/packs/skills-lock.json`) ────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackLockEntry {
    /// `owner/repo` the pack was installed from.
    pub(crate) source: String,
    /// Commit SHA captured at clone time (`git rev-parse HEAD`).
    pub(crate) commit: String,
    /// Content hash of the stored tree (same fn as skills — drift detection).
    pub(crate) content_hash: String,
    /// Unix seconds. `installed_at` is preserved across updates.
    pub(crate) installed_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PackLock {
    pub(crate) version: u32,
    pub(crate) packs: BTreeMap<String, PackLockEntry>,
}

impl Default for PackLock {
    fn default() -> Self {
        Self {
            version: 1,
            packs: BTreeMap::new(),
        }
    }
}

pub(crate) fn packs_base(root: &Path) -> PathBuf {
    atlas_profile::dir_in(root).join("packs")
}

fn pack_lock_path(root: &Path) -> PathBuf {
    packs_base(root).join("skills-lock.json")
}

/// Read the pack lock, tolerating a missing or malformed file (→ empty default).
pub(crate) fn read_pack_lock(root: &Path) -> PackLock {
    match fs::read_to_string(pack_lock_path(root)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PackLock::default(),
    }
}

pub(crate) fn write_pack_lock(root: &Path, lock: &PackLock) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(lock).map_err(|e| e.to_string())?;
    atomic_write(&pack_lock_path(root), &payload)
}

/// Canonical store dir for a pack, guarded to stay inside `<root>/.atlas/packs`
/// (mirrors [`canonical_skill_dir`]).
pub(crate) fn pack_store_dir(root: &Path, safe_name: &str) -> Result<PathBuf, String> {
    let base = packs_base(root);
    let dir = base.join(safe_name);
    let rel = dir
        .strip_prefix(&base)
        .map_err(|_| "path escapes packs base".to_string())?;
    let mut comps = rel.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == std::ffi::OsStr::new(safe_name) => Ok(dir),
        _ => Err(format!("unsafe resolved pack path for {safe_name:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::tmp_pack_dir;

    #[test]
    fn pack_store_dir_stays_in_base() {
        let root = tmp_pack_dir();
        let dir = pack_store_dir(&root, "my-pack").unwrap();
        assert!(dir.starts_with(packs_base(&root)));
        assert_eq!(dir.file_name().unwrap(), "my-pack");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_lock_round_trips() {
        let root = tmp_pack_dir();
        let mut lock = read_pack_lock(&root); // empty default
        assert!(lock.packs.is_empty());
        lock.packs.insert(
            "demo".into(),
            PackLockEntry {
                source: "o/r".into(),
                commit: "abc".into(),
                content_hash: "h".into(),
                installed_at: 100,
                updated_at: 200,
            },
        );
        write_pack_lock(&root, &lock).unwrap();
        let back = read_pack_lock(&root);
        assert_eq!(back.version, 1);
        let e = back.packs.get("demo").unwrap();
        assert_eq!(e.source, "o/r");
        assert_eq!(e.installed_at, 100);
        fs::remove_dir_all(&root).ok();
    }
}
