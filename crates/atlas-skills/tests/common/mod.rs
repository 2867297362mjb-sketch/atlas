//! Fixtures for the interface-level suites: everything here goes through the
//! crate's public interface or the on-disk layout it documents.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use atlas_skills::{PackSource, SkillStore};
use tempfile::TempDir;

pub fn write(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

pub fn skill_md(name: &str, description: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n")
}

/// A project root with Claude Code and Codex installed in it.
pub fn project_root() -> TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".claude")).unwrap();
    fs::create_dir_all(dir.path().join(".codex")).unwrap();
    dir
}

/// The store of project `root`. Project scope on purpose: at global scope a
/// `CLAUDE_CONFIG_DIR`/`CODEX_HOME` in the environment relocates a tool's
/// skills directory to the developer's real one.
pub fn project_store(home: &Path, root: &Path) -> SkillStore {
    SkillStore::open(Some(home), "project", Some(root.to_str().unwrap())).unwrap()
}

/// Everything under `root`: each directory, each file with its contents, each
/// symlink with its target. Two equal snapshots mean nothing changed on disk.
pub fn snapshot(root: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .to_string();
            let meta = path.symlink_metadata().unwrap();
            if meta.file_type().is_symlink() {
                let target = fs::read_link(&path).unwrap();
                out.insert(rel, format!("link -> {}", target.display()));
            } else if meta.is_dir() {
                out.insert(rel, "dir".to_string());
                walk(base, &path, out);
            } else {
                out.insert(rel, format!("file: {}", fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn copy_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let to = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).unwrap();
        }
    }
}

/// A [`PackSource`] that serves one directory on disk as every `owner/repo`:
/// the seam the app fills with GitHub. No network, no `git`.
pub struct LocalSource {
    pub dir: TempDir,
    commit: Mutex<String>,
    /// How many times content was fetched.
    pub fetches: AtomicUsize,
    /// The directory the last fetch handed out, which the store must remove.
    pub last_fetched: Mutex<Option<PathBuf>>,
}

impl LocalSource {
    pub fn new(commit: &str) -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
            commit: Mutex::new(commit.to_string()),
            fetches: AtomicUsize::new(0),
            last_fetched: Mutex::new(None),
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn set_commit(&self, commit: &str) {
        *self.commit.lock().unwrap() = commit.to_string();
    }

    pub fn fetch_count(&self) -> usize {
        self.fetches.load(Ordering::SeqCst)
    }
}

impl PackSource for LocalSource {
    fn fetch(&self, _owner: &str, _repo: &str) -> Result<(PathBuf, String), String> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        let out = tempfile::tempdir().map_err(|e| e.to_string())?.keep();
        copy_tree(self.dir.path(), &out);
        *self.last_fetched.lock().unwrap() = Some(out.clone());
        Ok((out, self.commit.lock().unwrap().clone()))
    }

    fn head_commit(&self, _owner: &str, _repo: &str) -> Result<String, String> {
        Ok(self.commit.lock().unwrap().clone())
    }
}

/// A source repo that ships one skill, `pdf-extract`.
pub fn skill_repo() -> LocalSource {
    let src = LocalSource::new("c1");
    write(
        &src.path().join("skills/pdf-extract/SKILL.md"),
        &skill_md("pdf-extract", "Pull text out of PDFs", "Use pdftotext."),
    );
    write(
        &src.path().join("skills/pdf-extract/notes.txt"),
        "extra file",
    );
    src
}

/// A source repo that ships a whole pack: every component kind.
pub fn pack_repo() -> LocalSource {
    let src = LocalSource::new("c1");
    let dir = src.path();
    write(
        &dir.join(".claude-plugin/plugin.json"),
        r#"{"name":"demo-pack","description":"a demo"}"#,
    );
    write(
        &dir.join("skills/foo/SKILL.md"),
        &skill_md("foo", "The foo skill", "foo body"),
    );
    write(
        &dir.join("agents/rev.md"),
        "---\ndescription: Reviews\n---\nagent",
    );
    write(&dir.join("commands/ship.md"), "command");
    write(&dir.join("rules/style.md"), "rule body");
    write(
        &dir.join("hooks/hooks.json"),
        r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.js"}]}]}}"#,
    );
    write(&dir.join("scripts/setup.js"), "console.log(1)");
    src
}
