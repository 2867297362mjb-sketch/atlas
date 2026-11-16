//! Path resolution and its security checks: the root for a scope, the
//! canonical store, name sanitizing, and the legacy-store migration.

use crate::disk::copy_dir_all;
use std::fs;
use std::path::{Component, Path, PathBuf};

// ── Path resolution + security ─────────────────────────────────────────────────

/// Resolve `<root>` for a scope. Global → home dir; project → the given path.
/// `home` is the caller's: this crate never looks the home directory up.
fn root_for(
    home: Option<&Path>,
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf, String> {
    match scope {
        "global" => home
            .map(Path::to_path_buf)
            .ok_or_else(|| "could not resolve home directory".to_string()),
        "project" => {
            let p = project_path
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| "project scope requires a projectPath".to_string())?;
            let path = PathBuf::from(p);
            // Lexically reject parent-dir traversal. The project root may not
            // exist yet, so we cannot canonicalize; instead refuse any `..`
            // segment so a crafted path can't escape `.agents/skills` later.
            if path.components().any(|c| matches!(c, Component::ParentDir)) {
                return Err(
                    "invalid projectPath: parent-directory segments are not allowed".to_string(),
                );
            }
            Ok(path)
        }
        other => Err(format!("invalid scope: {other}")),
    }
}

/// `<root>/.agents/skills` — the canonical store base. This is the same
/// `.agents/skills` layout skills.sh and Zed already read/write (ADR 0005);
/// Atlas does not keep a separate store.
pub(crate) fn skills_base(root: &Path) -> PathBuf {
    root.join(".agents").join("skills")
}

/// `<root>/.atlas/skills` — the pre-convergence canonical store. Superseded by
/// [`skills_base`]; only consulted by [`migrate_legacy_skills`] to move any
/// leftover content from an Atlas install that predates the store convergence.
fn legacy_skills_base(root: &Path) -> PathBuf {
    atlas_profile::dir_in(root).join("skills")
}

/// One-time migration of anything still sitting in the pre-convergence
/// `.atlas/skills` store into the new canonical `.agents/skills` store.
/// Best-effort and idempotent: called on every discovery pass, but becomes a
/// no-op as soon as the legacy dir is empty (no sentinel file needed) — on the
/// maintainer's machine this never had content, but other users who installed
/// skills through Atlas before the convergence do. A skill name already present
/// in the new store wins; the legacy copy is left in place rather than
/// clobbered. Renames when possible (same volume), copies as a fallback.
fn migrate_legacy_skills(root: &Path) {
    let legacy = legacy_skills_base(root);
    let Ok(entries) = fs::read_dir(&legacy) else {
        return;
    };
    let new_base = skills_base(root);
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue; // e.g. the legacy `.projections.json` ledger file
        }
        if !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(safe_name) = sanitize_name(&raw_name) else {
            continue;
        };
        let Ok(dst) = canonical_skill_dir(&new_base, &safe_name) else {
            continue;
        };
        if dst.exists() {
            continue; // new store already has this skill — don't clobber
        }
        if let Some(parent) = dst.parent() {
            if fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let src = entry.path();
        if fs::rename(&src, &dst).is_ok() {
            eprintln!(
                "skills: migrated legacy skill '{safe_name}' from {} to {}",
                src.display(),
                dst.display()
            );
        } else if copy_dir_all(&src, &dst).is_ok() {
            // Cross-device rename failed — fall back to copy, leaving the
            // legacy copy in place (best-effort, not fatal to discovery).
            eprintln!(
                "skills: copied legacy skill '{safe_name}' from {} to {} (legacy copy left in place)",
                src.display(),
                dst.display()
            );
        } else {
            // Both rename and copy failed (permissions, disk full, …) — not
            // fatal to discovery, but worth a trace instead of vanishing
            // silently; the skill stays in the legacy dir and migration
            // retries on the next discovery pass.
            eprintln!(
                "skills: failed to migrate legacy skill '{safe_name}' from {} — left in place, will retry",
                src.display()
            );
        }
    }
}

/// Sanitize a skill name into a safe single path segment.
///
/// - lowercase; `[^a-z0-9._]+` → `-`; collapse runs; strip leading/trailing
///   `.`/`-`; cap at 255 chars.
/// - reject empty results and anything that still looks like traversal.
pub(crate) fn sanitize_name(name: &str) -> Result<String, String> {
    let lowered = name.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut prev_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' {
            out.push(ch);
            prev_dash = false;
        } else {
            // collapse any run of disallowed chars into a single '-'
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
    }
    let trimmed = out.trim_matches(['.', '-']).to_string();
    let capped: String = trimmed.chars().take(255).collect();
    let capped = capped.trim_matches(['.', '-']).to_string();

    if capped.is_empty() {
        return Err(format!("invalid skill name: {name:?}"));
    }
    // Defense in depth: no path separators, no `.`/`..` segment.
    if capped == "." || capped == ".." || capped.contains('/') || capped.contains('\\') {
        return Err(format!("unsafe skill name: {name:?}"));
    }
    Ok(capped)
}

/// Resolve the canonical skill directory for a sanitized name and verify it
/// stays inside `<root>/.agents/skills` (no `..` escape).
pub(crate) fn canonical_skill_dir(base: &Path, safe_name: &str) -> Result<PathBuf, String> {
    let dir = base.join(safe_name);
    // The only non-base component must be exactly `safe_name`.
    let rel = dir
        .strip_prefix(base)
        .map_err(|_| "path escapes skills base".to_string())?;
    let mut comps = rel.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(seg)), None) if seg == std::ffi::OsStr::new(safe_name) => Ok(dir),
        _ => Err(format!("unsafe resolved path for {safe_name:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::tmp_root;

    #[test]
    fn sanitize_lowercases_and_replaces_spaces() {
        assert_eq!(sanitize_name("My Cool Skill").unwrap(), "my-cool-skill");
        assert_eq!(sanitize_name("PDF Extract").unwrap(), "pdf-extract");
        assert_eq!(sanitize_name("a   b").unwrap(), "a-b"); // collapse runs
    }

    #[test]
    fn sanitize_rejects_traversal() {
        // "../evil" → disallowed chars become '-', leading dashes stripped → "evil".
        let safe = sanitize_name("../evil").unwrap();
        assert_eq!(safe, "evil");
        assert!(!safe.contains('/'));
        assert!(!safe.contains(".."));
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_name("   ").is_err());
        assert!(sanitize_name("///").is_err());
        assert!(sanitize_name("...").is_err());
    }

    #[test]
    fn canonical_dir_stays_in_base() {
        let root = tmp_root();
        let base = skills_base(&root);
        let dir = canonical_skill_dir(&base, "pdf-extract").unwrap();
        assert!(dir.starts_with(&base));
        assert_eq!(dir.file_name().unwrap(), "pdf-extract");
        fs::remove_dir_all(&root).ok();
    }
}
