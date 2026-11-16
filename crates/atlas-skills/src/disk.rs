//! Disk helpers: durable writes, the symlink/copy that materializes a
//! projection, recursive copy, and the content hash used for drift detection.

use crate::paths::{canonical_skill_dir, skills_base};
use crate::registry::{tool_link_path, tool_skills_dir, ToolDef};
use std::fs;
use std::path::{Path, PathBuf};

// ── Disk helpers ───────────────────────────────────────────────────────────────

/// [`atlas_fs::replace_file`] in this module's error type.
pub(crate) fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    atlas_fs::replace_file(path, payload).map_err(|e| e.to_string())
}

/// Compute the relative symlink target from a tool's skills dir up to the
/// canonical `<root>/.agents/skills/<name>`. Used only for `<root>`-relative dirs
/// (the common case). For env-relocated absolute dirs we fall back to an absolute
/// target via [`canonical_symlink_target`].
fn relative_symlink_target(skills_dir_rel: &Path, safe_name: &str) -> PathBuf {
    let up = "../".repeat(skills_dir_rel.components().count());
    PathBuf::from(format!("{up}.agents/skills/{safe_name}"))
}

/// Best symlink target for a projection: relative when the tool dir is under
/// `<root>` (keeps the link valid if the tree moves), absolute otherwise (env
/// override relocated the dir outside `<root>`).
fn canonical_symlink_target(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> PathBuf {
    let dir = tool_skills_dir(def, scope, root);
    if let Ok(rel) = dir.strip_prefix(root) {
        relative_symlink_target(rel, safe_name)
    } else {
        skills_base(root).join(safe_name)
    }
}

/// Wipe whatever entry sits at the projection path (symlink/file/dir), so we can
/// re-materialize cleanly. Only ever the `<name>` entry inside the tool dir.
fn clear_entry(link: &Path) -> Result<(), String> {
    if let Ok(meta) = link.symlink_metadata() {
        if !meta.file_type().is_symlink() && meta.is_dir() {
            fs::remove_dir_all(link).map_err(|e| e.to_string())?;
        } else {
            let _ = fs::remove_file(link);
        }
    }
    Ok(())
}

/// Create a relative symlink from the tool skills dir to the canonical skill.
/// Idempotent: a stale entry is removed first, then recreated.
fn create_symlink(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    let target = canonical_symlink_target(root, def, scope, safe_name);
    symlink(&target, &link).map_err(|e| format!("symlink failed: {e}"))
}

/// Materialize a copy projection: recursively copy canonical → tool dir.
fn create_copy(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    if !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    copy_dir_all(&canonical, &link)
}

/// Remove a tool's projection for a skill (symlink or copy). Best-effort.
fn remove_symlink(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    clear_entry(&link)
}

#[cfg(unix)]
pub(crate) fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
pub(crate) fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are only supported on unix in v1",
    ))
}

/// Recursively copy `src` → `dst` (dirs + files), creating parents as needed.
/// Used by `adopt_skill` to lift an external skill into the canonical store
/// without a new dependency. Symlinks inside the source are not followed into
/// new symlinks — their target contents are copied through `fs::copy`.
pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Content hashing (CP.3) ───────────────────────────────────────────────────────

/// Stable content hash of a skill directory for **change detection** (not
/// security). Walks every file under `dir` sorted by relative path and folds
/// `(relpath_bytes, 0x00, file_bytes)` into a 64-bit FNV-1a, returned as hex.
/// Missing dir → empty string (treated as "no content").
fn hash_skill_dir(dir: &Path) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    // Collect (relative-path, absolute-path) for every file, sorted by relpath.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash = FNV_OFFSET;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for (rel, abs) in &files {
        fold(rel.as_bytes());
        fold(&[0x00]);
        if let Ok(bytes) = fs::read(abs) {
            fold(&bytes);
        }
    }
    format!("{hash:016x}")
}

/// Recursively gather files under `dir` as `(relative-to-base path, abs path)`.
/// Symlinks are not followed (only real files contribute to the hash).
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}
