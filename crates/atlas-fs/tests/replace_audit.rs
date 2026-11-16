//! Source-level audit: the only place a file is replaced by "write a temp
//! file, then rename it over the target" is `crates/atlas-fs/src/lib.rs`.
//!
//! [`atlas_fs::replace_file`] syncs the temp file before the rename and the
//! directory after it, names the temp file uniquely, and removes it on
//! failure. A writer that rolls its own does none of that, and nothing fails:
//! it compiles, its round-trip test passes, and the file it "saved" is empty
//! after a power cut, or two saves in one moment rename each other's temp
//! file away. The compiler cannot see it, so this test walks the source.
//!
//! What counts as a site, in production code (test modules, `tests/`,
//! `benches/`, `examples/` and `build.rs` are skipped: a test may arrange its
//! fixture files however it likes):
//!
//! - a rename through the standard library or tokio: `fs::rename(`;
//! - a temp path being built: a string literal that ends in `.tmp`, or
//!   `.with_extension("tmp")`.
//!
//! `ALLOWED` lists the files where a rename is not a hand-rolled replace
//! (moving a directory, setting a damaged database aside, finishing a
//! download that was streamed to disk), each with how many sites it has. The
//! test fails on a site in a file that is not listed, on a listed file whose
//! count changed, and on an entry that no longer matches anything.
//!
//! What it cannot see: a plain `fs::write` over a state file. That is a torn
//! file after a crash and belongs in `replace_file` too, but `fs::write` has
//! too many legitimate uses (exports to a path the user picked, files in a
//! fresh temp directory, files in the user's own repository, where replacing
//! by rename would turn a symlink into a regular file and reset the
//! permissions) for a source scan to tell them apart. Review has to.
//!
//! Out of scope: `vendor/atlas-engine`, which keeps its own writers.

use std::fs;
use std::path::{Path, PathBuf};

/// The one file allowed to replace a file by temp-and-rename.
const CHOKEPOINT: &str = "crates/atlas-fs/src/lib.rs";

/// Files whose renames are not a hand-rolled replace: path, how many sites,
/// and why (20+ characters, checked).
const ALLOWED: &[(&str, usize, &str)] = &[
    (
        "src-tauri/src/commands/fs.rs",
        2,
        "the file tree's rename command: it moves an entry in the user's project, by request",
    ),
    (
        "src-tauri/src/commands/log.rs",
        1,
        "moves the legacy pinned log to its per-organisation path once; nothing is rewritten",
    ),
    (
        "src-tauri/src/commands/models.rs",
        1,
        "a model download streamed to a .part file: the bytes are never in memory to hand over",
    ),
    (
        "src-tauri/src/commands/updater_download.rs",
        1,
        "an update download streamed to a .part file: the bytes are never in memory to hand over",
    ),
    (
        "src-tauri/src/commands/updater_macos.rs",
        3,
        "swaps whole .app bundles (directories) with a .bak rollback, not a file's contents",
    ),
    (
        "crates/atlas-skills/src/paths.rs",
        1,
        "moves a skill directory between stores, with a copy fallback across devices",
    ),
    (
        "crates/atlas-memory/src/health.rs",
        2,
        "the snapshot is written by SQLite's VACUUM INTO, which takes a path, then renamed",
    ),
    (
        "crates/atlas-memory/src/global.rs",
        1,
        "sets an unreadable ledger aside under a .corrupt name; nothing is rewritten",
    ),
    (
        "crates/atlas-memory/src/corpus.rs",
        1,
        "sets a damaged corpus database and its sidecars aside under a .corrupt name",
    ),
    (
        "crates/atlas-memory/src/record.rs",
        1,
        "sets a damaged memory database and its sidecars aside under a .corrupt name",
    ),
    (
        "crates/atlas-security/src/deps/osv.rs",
        2,
        "the advisory index is streamed through a BufWriter: far too large to build in memory twice",
    ),
    (
        "crates/atlas-instruction-sync/src/lib.rs",
        1,
        "writes the user's own instruction files under a compare-before-commit check, keeping their permissions",
    ),
    (
        "crates/atlas-agent-store/src/servers.rs",
        3,
        "sets node_modules and the lockfile aside for an install attempt and puts them back",
    ),
    (
        "crates/atlas-agent-store/src/archive.rs",
        2,
        "moves an extracted archive directory, or a downloaded binary, into its install path",
    ),
    (
        "crates/atlas-native-agent/src/linux_sandbox.rs",
        1,
        "renames a staged symlink into place: the alias for the sandbox helper, not file contents",
    ),
    (
        "crates/atlas-icon-theme/src/lib.rs",
        1,
        "swaps a staged, validated icon-theme directory into place, not a file's contents",
    ),
];

/// The fewest Rust files a real walk of `src-tauri/src` and `crates` finds.
/// Far below today's count: it is a floor against scanning nothing.
const MIN_FILES: usize = 200;

fn skipped(path: &str) -> bool {
    const FRAGMENTS: &[&str] = &[
        "/tests/",
        "/testing/",
        "_tests.rs",
        "/tests.rs",
        "/benches/",
        "/examples/",
        "/build.rs",
    ];
    FRAGMENTS.iter().any(|f| path.contains(f))
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name == "target" || name == "node_modules" || name.starts_with('.') {
                continue;
            }
            walk(&path, out);
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

/// Whether `line` renames a path or builds a temp path.
fn replaces_by_hand(line: &str) -> bool {
    line.contains("fs::rename(")
        || line.contains(".tmp\"")
        || line.contains(".with_extension(\"tmp\")")
}

/// The 1-indexed lines of `src` that are sites, production code only.
fn sites_in(src: &str) -> Vec<usize> {
    let lines: Vec<&str> = src.lines().collect();
    let mut sites = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        // Everything after the first `#[cfg(test)]`-gated module is test
        // code; the test module is conventionally last in the file.
        if (trimmed.starts_with("#[cfg(test)]") || trimmed.starts_with("#[cfg(all(test"))
            && lines[i + 1..(i + 4).min(lines.len())]
                .iter()
                .any(|l| l.trim_start().starts_with("mod "))
        {
            break;
        }
        if !trimmed.starts_with("//") && replaces_by_hand(line) {
            sites.push(i + 1);
        }
    }
    sites
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn the_scanner_sees_a_hand_rolled_replace_and_ignores_tests_and_comments() {
    for site in [
        r#"std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;"#,
        r#"tokio::fs::rename(&tmp, &path).await?;"#,
        r#"fs::rename(from, to)"#,
        r#"let tmp = path.with_extension("json.tmp");"#,
        r#"let tmp = path.with_extension("tmp");"#,
        r#"let tmp = dir.join(format!(".{file}.tmp"));"#,
        r#"s.push(".tmp");"#,
    ] {
        assert_eq!(sites_in(site), vec![1], "{site}");
    }
    for not_a_site in [
        r#"// fs::rename(&tmp, &path) is what this used to do."#,
        r#"atlas_fs::replace_file(&path, bytes)?;"#,
        r#"std::fs::write(&path, bytes)?;"#,
        r#"let dir = std::env::temp_dir().join("atlas-tmp");"#,
        r#"git(&["branch", "-m", old, new]) // a rename("#,
    ] {
        assert!(sites_in(not_a_site).is_empty(), "{not_a_site}");
    }
    let with_tests =
        "fn real() {}\n#[cfg(test)]\nmod tests {\n    fn g() { std::fs::rename(a, b); }\n}\n";
    assert!(sites_in(with_tests).is_empty());
}

#[test]
fn every_file_is_replaced_through_the_chokepoint() {
    let root = repo_root();
    let mut files = Vec::new();
    for dir in ["src-tauri/src", "crates"] {
        walk(&root.join(dir), &mut files);
    }
    assert!(
        files.len() >= MIN_FILES,
        "walked {} Rust files, expected at least {MIN_FILES}: the audit is not seeing the workspace",
        files.len()
    );

    for (path, _, reason) in ALLOWED {
        assert!(
            reason.len() >= 20,
            "{path}: an allowlist entry needs a real reason"
        );
    }

    let mut found_chokepoint = false;
    let mut new_sites: Vec<String> = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    let mut allowed_hit: Vec<&str> = Vec::new();
    for file in &files {
        let rel = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if skipped(&format!("/{rel}")) {
            continue;
        }
        let Ok(src) = fs::read_to_string(file) else {
            continue;
        };
        let sites = sites_in(&src);
        if rel == CHOKEPOINT {
            // The scanner run over the chokepoint must report it: proof that
            // it recognises the real thing, not only this file's samples.
            found_chokepoint = !sites.is_empty();
            continue;
        }
        if sites.is_empty() {
            continue;
        }
        let lines = || {
            sites
                .iter()
                .map(|line| format!("{rel}:{line}"))
                .collect::<Vec<_>>()
        };
        match ALLOWED.iter().find(|(path, _, _)| *path == rel) {
            Some((path, count, _)) => {
                allowed_hit.push(path);
                if sites.len() != *count {
                    changed.push(format!(
                        "{rel}: {count} allowed, {} found ({})",
                        sites.len(),
                        lines().join(", ")
                    ));
                }
            }
            None => new_sites.extend(lines()),
        }
    }

    assert!(
        found_chokepoint,
        "{CHOKEPOINT} was not found, or the scanner no longer sees the rename in it"
    );
    assert!(
        new_sites.is_empty(),
        "a rename or a temp path outside {CHOKEPOINT}. To replace a file's contents call \
         atlas_fs::replace_file (or replace_file_with_mode for a private file); if this is \
         not a replace, add the file to ALLOWED with its site count and the reason:\n  {}",
        new_sites.join("\n  ")
    );
    assert!(
        changed.is_empty(),
        "an allowed file's sites changed. A new one that replaces a file's contents goes \
         through atlas_fs::replace_file; otherwise update the count in ALLOWED:\n  {}",
        changed.join("\n  ")
    );
    let stale: Vec<&str> = ALLOWED
        .iter()
        .map(|(path, _, _)| *path)
        .filter(|path| !allowed_hit.contains(path))
        .collect();
    assert!(
        stale.is_empty(),
        "ALLOWED entries with no rename or temp path left: remove them: {stale:?}"
    );
}
