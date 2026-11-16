//! Pack ingest and parse: a directory in the plugin layout becomes a [`Pack`].

use crate::frontmatter::parse_frontmatter;
use crate::model::{ComponentKind, Pack, PackComponent, PluginManifest};
use crate::paths::sanitize_name;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Read the frontmatter `description` of a component's markdown. For a skill the
/// source is its directory (we read its `SKILL.md`); for other kinds it's the
/// `.md` file itself. Returns `None` for non-markdown or empty descriptions.
fn read_component_description(kind: ComponentKind, src: &Path) -> Option<String> {
    let md = if kind == ComponentKind::Skill {
        src.join("SKILL.md")
    } else {
        src.to_path_buf()
    };
    if md.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let raw = fs::read_to_string(&md).ok()?;
    let desc = parse_frontmatter(&raw).0.description?;
    let desc = desc.trim();
    if desc.is_empty() {
        None
    } else {
        Some(desc.to_string())
    }
}

// ── Pack ingest & parse (pack-install plan, Phase 1) ─────────────────────────────
//
// A *pack* is a directory in the Claude Code plugin layout. Parsing is
// "manifest-or-infer": `.claude-plugin/plugin.json` supplies metadata (and the
// pack name) when present, but components are always discovered from the
// conventional top-level dirs (`skills/`, `agents/`, `commands/`, `hooks/`,
// `rules/`, `scripts/`). Unknown dirs (and `.claude-plugin` itself) are ignored.
// This phase only *reads* — nothing is projected or executed here.

/// Read `<dir>/.claude-plugin/plugin.json` if present. Tolerant: a missing or
/// malformed manifest yields `None` (the pack still parses via layout inference).
fn read_pack_manifest(dir: &Path) -> Option<PluginManifest> {
    let path = dir.join(".claude-plugin").join("plugin.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Resolve the canonical pack name: the manifest `name` (sanitized) if non-empty,
/// else the directory's basename (sanitized).
fn pack_name(dir: &Path, manifest: Option<&PluginManifest>) -> Result<String, String> {
    if let Some(name) = manifest.and_then(|m| m.name.as_deref()) {
        let name = name.trim();
        if !name.is_empty() {
            return sanitize_name(name);
        }
    }
    let base = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "pack path has no directory name".to_string())?;
    sanitize_name(&base)
}

/// The repo segment of an install `source` (`owner/repo`, possibly a `.git` URL),
/// used as the pack-name fallback when the manifest has no `name`. e.g.
/// `"vercel-labs/agent-skills"` → `"agent-skills"`.
pub(crate) fn repo_name_from_source(source: &str) -> String {
    source
        .trim()
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(source)
        .trim_end_matches(".git")
        .to_string()
}

/// Relative path of `path` under `pack_root`, with `/` separators. Rejects any
/// `..` escape (defense in depth — entries come from `read_dir`, but never trust).
fn pack_rel(pack_root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(pack_root).ok()?;
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Recursively collect regular files under `dir`, skipping dot-entries
/// (`.DS_Store`, hidden dirs). Order is unspecified — callers sort.
fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => walk_files(&entry.path(), out),
            Ok(t) if t.is_file() => out.push(entry.path()),
            _ => {}
        }
    }
}

/// Which files count as a component of this `kind`. Agents/commands/rules are
/// markdown; hooks are JSON; scripts are any file. (Skills are dir-based and
/// handled separately.)
fn kind_accepts_file(kind: ComponentKind, path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    match kind {
        ComponentKind::Agent | ComponentKind::Command | ComponentKind::Rule => {
            ext.eq_ignore_ascii_case("md")
        }
        ComponentKind::Hook => ext.eq_ignore_ascii_case("json"),
        ComponentKind::Script => true,
        ComponentKind::Skill => false,
    }
}

/// Projection leaf name for a file component: scripts keep their extension
/// (they're executed by name); everything else uses the stem (`review.md` →
/// `review`, `hooks.json` → `hooks`).
fn component_file_name(kind: ComponentKind, path: &Path) -> Option<String> {
    let part = match kind {
        ComponentKind::Script => path.file_name(),
        _ => path.file_stem(),
    };
    part.map(|s| s.to_string_lossy().to_string())
}

/// Append the components of one `kind` found under `kind_dir` to `out`.
fn collect_kind(
    pack_root: &Path,
    kind: ComponentKind,
    kind_dir: &Path,
    out: &mut Vec<PackComponent>,
) {
    if kind == ComponentKind::Skill {
        // Each immediate subdir that owns a `SKILL.md` is one skill.
        let Ok(rd) = fs::read_dir(kind_dir) else {
            return;
        };
        for entry in rd.flatten() {
            let dir = entry.path();
            if dir.is_dir() && dir.join("SKILL.md").is_file() {
                if let (Some(rel), Some(name)) = (
                    pack_rel(pack_root, &dir),
                    dir.file_name().map(|s| s.to_string_lossy().to_string()),
                ) {
                    let description = read_component_description(kind, &dir);
                    out.push(PackComponent {
                        kind,
                        rel_path: rel,
                        name,
                        description,
                    });
                }
            }
        }
        return;
    }

    let mut files = Vec::new();
    walk_files(kind_dir, &mut files);
    for file in files {
        if !kind_accepts_file(kind, &file) {
            continue;
        }
        if let (Some(rel), Some(name)) =
            (pack_rel(pack_root, &file), component_file_name(kind, &file))
        {
            let description = read_component_description(kind, &file);
            out.push(PackComponent {
                kind,
                rel_path: rel,
                name,
                description,
            });
        }
    }
}

/// Flatten a manifest component field (`"path"` or `["a","b"]`) into paths.
fn manifest_field_paths(v: &Option<serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::String(s)) => vec![s.clone()],
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

/// The (kind, relative-path) components a manifest explicitly declares.
fn manifest_declared(m: &PluginManifest) -> Vec<(ComponentKind, String)> {
    let mut out = Vec::new();
    for (kind, field) in [
        (ComponentKind::Skill, &m.skills),
        (ComponentKind::Command, &m.commands),
        (ComponentKind::Agent, &m.agents),
        (ComponentKind::Hook, &m.hooks),
    ] {
        for p in manifest_field_paths(field) {
            out.push((kind, p));
        }
    }
    out
}

/// Resolve a manifest-declared path under `pack_root` and collect its components
/// of `kind`. Handles a directory (scanned) or a direct file (e.g. a `hooks.json`
/// pointed at by `"hooks"`). Paths that don't exist or escape the root are
/// ignored — manifest content is never trusted blindly.
fn collect_manifest_path(
    pack_root: &Path,
    kind: ComponentKind,
    rel: &str,
    out: &mut Vec<PackComponent>,
) {
    let candidate = pack_root.join(rel.trim_start_matches("./"));
    if pack_rel(pack_root, &candidate).is_none() {
        return; // traversal / escape
    }
    if candidate.is_dir() {
        collect_kind(pack_root, kind, &candidate, out);
    } else if candidate.is_file()
        && kind != ComponentKind::Skill
        && kind_accepts_file(kind, &candidate)
    {
        if let (Some(rel_path), Some(name)) = (
            pack_rel(pack_root, &candidate),
            component_file_name(kind, &candidate),
        ) {
            let description = read_component_description(kind, &candidate);
            out.push(PackComponent {
                kind,
                rel_path,
                name,
                description,
            });
        }
    }
}

/// Parse a pack directory into a [`Pack`]: read the optional manifest, then
/// enumerate components. If the manifest declares component paths
/// (`skills`/`commands`/`agents`/`hooks`) it is authoritative — only those paths
/// are collected, so unrelated top-level dirs (e.g. a product repo's build
/// `scripts/`) are not mistaken for components. Otherwise we fall back to
/// inferring from the conventional top-level layout. Output is sorted by
/// `(kind, rel_path)` for deterministic results.
pub(crate) fn pack_parse(dir: &Path) -> Result<Pack, String> {
    if !dir.is_dir() {
        return Err(format!("pack path is not a directory: {}", dir.display()));
    }
    let manifest = read_pack_manifest(dir);
    let name = pack_name(dir, manifest.as_ref())?;

    let mut components = Vec::new();
    let declared = manifest.as_ref().map(manifest_declared).unwrap_or_default();
    if declared.is_empty() {
        // No manifest-declared paths → infer from conventional top-level layout.
        let rd = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in rd.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(kind) = ComponentKind::from_dir_name(&entry.file_name().to_string_lossy()) {
                collect_kind(dir, kind, &entry.path(), &mut components);
            }
        }
    } else {
        // Manifest is authoritative — collect only what it declares.
        for (kind, rel) in declared {
            collect_manifest_path(dir, kind, &rel, &mut components);
        }
    }
    components.sort_by(|a, b| (a.kind.as_str(), &a.rel_path).cmp(&(b.kind.as_str(), &b.rel_path)));

    Ok(Pack {
        name,
        root: dir.to_string_lossy().to_string(),
        manifest,
        components,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{comp_names, tmp_pack_dir, write_file};

    #[test]
    fn pack_parse_infers_all_kinds_from_layout() {
        let dir = tmp_pack_dir();
        // A full Claude Code plugin layout, no manifest.
        write_file(
            &dir.join("skills/foo/SKILL.md"),
            "---\nname: foo\n---\nbody",
        );
        write_file(
            &dir.join("skills/bar/SKILL.md"),
            "---\nname: bar\n---\nbody",
        );
        write_file(
            &dir.join("skills/not-a-skill/README.md"),
            "no skill md here",
        );
        write_file(&dir.join("agents/review.md"), "agent");
        write_file(&dir.join("commands/ship.md"), "command");
        write_file(&dir.join("commands/ns/deep.md"), "nested command");
        write_file(&dir.join("hooks/hooks.json"), "{}");
        write_file(&dir.join("rules/style.md"), "rule");
        write_file(&dir.join("scripts/setup.js"), "console.log(1)");
        write_file(&dir.join("docs/ignored.md"), "not a component dir");
        write_file(&dir.join("scripts/.hidden"), "skip dotfiles");

        let pack = pack_parse(&dir).unwrap();
        // No manifest → name from dir basename (sanitized).
        assert_eq!(
            pack.name,
            sanitize_name(dir.file_name().unwrap().to_str().unwrap()).unwrap()
        );
        assert!(pack.manifest.is_none());

        // Skills: only dirs with SKILL.md; the README-only dir is excluded.
        let mut skills = comp_names(&pack, ComponentKind::Skill);
        skills.sort();
        assert_eq!(skills, vec!["bar".to_string(), "foo".to_string()]);

        // Agents / rules use the stem.
        assert_eq!(
            comp_names(&pack, ComponentKind::Agent),
            vec!["review".to_string()]
        );
        assert_eq!(
            comp_names(&pack, ComponentKind::Rule),
            vec!["style".to_string()]
        );

        // Commands recurse into namespaces (stem only).
        let mut cmds = comp_names(&pack, ComponentKind::Command);
        cmds.sort();
        assert_eq!(cmds, vec!["deep".to_string(), "ship".to_string()]);

        // Hooks = JSON files (stem).
        assert_eq!(
            comp_names(&pack, ComponentKind::Hook),
            vec!["hooks".to_string()]
        );

        // Scripts keep their extension; dotfiles are skipped.
        assert_eq!(
            comp_names(&pack, ComponentKind::Script),
            vec!["setup.js".to_string()]
        );

        // `docs/` is not a recognized component dir → contributes nothing.
        assert_eq!(
            pack.components
                .iter()
                .filter(|c| c.rel_path.starts_with("docs/"))
                .count(),
            0
        );

        // Output is deterministically sorted by (kind, rel_path).
        let mut sorted = pack.components.clone();
        sorted.sort_by(|a, b| (a.kind.as_str(), &a.rel_path).cmp(&(b.kind.as_str(), &b.rel_path)));
        assert_eq!(pack.components, sorted);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_uses_manifest_name_when_present() {
        let dir = tmp_pack_dir();
        write_file(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"My Cool Pack","version":"1.2.0","description":"hi"}"#,
        );
        write_file(&dir.join("agents/a.md"), "agent");

        let pack = pack_parse(&dir).unwrap();
        assert_eq!(pack.name, "my-cool-pack"); // sanitized manifest name wins
        let m = pack.manifest.as_ref().expect("manifest parsed");
        assert_eq!(m.version.as_deref(), Some("1.2.0"));
        assert_eq!(m.description.as_deref(), Some("hi"));
        assert_eq!(
            comp_names(&pack, ComponentKind::Agent),
            vec!["a".to_string()]
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_tolerates_missing_and_malformed_manifest() {
        // Malformed plugin.json → treated as absent, name falls back to basename.
        let dir = tmp_pack_dir();
        write_file(&dir.join(".claude-plugin/plugin.json"), "{ not json");
        write_file(&dir.join("skills/x/SKILL.md"), "---\nname: x\n---\n");
        let pack = pack_parse(&dir).unwrap();
        assert!(pack.manifest.is_none());
        assert_eq!(
            comp_names(&pack, ComponentKind::Skill),
            vec!["x".to_string()]
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_empty_pack_yields_no_components() {
        let dir = tmp_pack_dir();
        let pack = pack_parse(&dir).unwrap();
        assert!(pack.components.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_rejects_non_directory() {
        let dir = tmp_pack_dir();
        let file = dir.join("plain.txt");
        write_file(&file, "hi");
        assert!(pack_parse(&file).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_honors_manifest_declared_paths() {
        // Plugin keeps its real components in non-conventional locations and
        // declares them in the manifest; an unrelated top-level build `scripts/`
        // must NOT be ingested (the impeccable misdetection).
        let dir = tmp_pack_dir();
        write_file(
            &dir.join(".claude-plugin/plugin.json"),
            r#"{"name":"mani","skills":"./.claude/skills","hooks":"./plugin/hooks/hooks.json"}"#,
        );
        write_file(
            &dir.join(".claude/skills/foo/SKILL.md"),
            "---\nname: foo\n---\nbody",
        );
        write_file(&dir.join("plugin/hooks/hooks.json"), r#"{"hooks":{}}"#);
        write_file(&dir.join("scripts/build.js"), "console.log(1)"); // build tooling, not a component

        let pack = pack_parse(&dir).unwrap();
        assert!(pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Skill && c.name == "foo"));
        assert!(pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Hook));
        assert!(
            !pack
                .components
                .iter()
                .any(|c| c.kind == ComponentKind::Script),
            "manifest-declared pack must not ingest top-level build scripts"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pack_parse_falls_back_to_layout_without_manifest_paths() {
        // Manifest present but declares no component paths → top-level inference.
        let dir = tmp_pack_dir();
        write_file(&dir.join(".claude-plugin/plugin.json"), r#"{"name":"lay"}"#);
        write_file(&dir.join("agents/a.md"), "agent");
        write_file(&dir.join("scripts/setup.js"), "x");

        let pack = pack_parse(&dir).unwrap();
        assert!(pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Agent));
        assert!(pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Script));

        fs::remove_dir_all(&dir).ok();
    }
}
