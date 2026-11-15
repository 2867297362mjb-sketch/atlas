//! Replace a file's contents so that a crash never leaves it torn.
//!
//! Every Atlas store that rewrites a whole file in place (`config.toml`, a
//! skill, a memory ledger, the shell profile that holds exported keys) wants
//! the same guarantee: a reader, or the next launch after a power cut, sees
//! either the old contents or the new ones, never half of either and never an
//! empty file. [`replace_file`] is that guarantee, written once.
//!
//! What it does, in order:
//!
//! 1. Creates the parent directory if it is missing.
//! 2. Creates a **unique** temp file in that same directory (same directory so
//!    the rename cannot cross a filesystem; unique so two writers, or two
//!    targets that share a stem such as `a.json` and `a.md`, never share one).
//! 3. Writes the bytes and `fsync`s the file. Without this the rename can
//!    reach the disk ahead of the data it names, and power loss just after
//!    "saved" leaves the target pointing at an empty inode.
//! 4. Renames the temp over the target, which is atomic.
//! 5. `fsync`s the directory so the rename itself is durable. Best effort:
//!    some filesystems, and Windows, refuse to open a directory for sync, and
//!    that is not worth failing an otherwise successful write over.
//!
//! On any failure the temp file is removed, and the target is left as it was.
//!
//! Concurrent callers replacing one path each land a complete file; the last
//! rename wins. This serializes nothing: a read-modify-write still needs the
//! caller's own lock.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Replace the contents of `path` with `bytes`, creating the file and its
/// parent directories when absent.
///
/// The new file gets the platform's default permissions for a created file,
/// not the replaced file's. Use [`replace_file_with_mode`] to choose them.
pub fn replace_file(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    replace(path.as_ref(), bytes.as_ref(), None)
}

/// [`replace_file`], with the new file's Unix permission bits set to exactly
/// `mode` (the umask is not applied) before it becomes visible at `path`.
///
/// The temp file is created no wider than `mode`, so contents that must stay
/// private (`0o600`) are never readable by anyone else, even briefly. `mode`
/// is ignored on platforms without Unix permissions.
pub fn replace_file_with_mode(
    path: impl AsRef<Path>,
    bytes: impl AsRef<[u8]>,
    mode: u32,
) -> io::Result<()> {
    replace(path.as_ref(), bytes.as_ref(), Some(mode))
}

fn replace(path: &Path, bytes: &[u8], mode: Option<u32>) -> io::Result<()> {
    if path.file_name().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} does not name a file", path.display()),
        ));
    }
    // A bare relative name has the empty path as its parent.
    let dir = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    fs::create_dir_all(dir)?;

    let (mut file, temp) = create_temp(dir, mode)?;
    let written = (|| {
        file.write_all(bytes)?;
        set_mode(&file, mode)?;
        file.sync_all()?;
        // Closed before the rename: Windows will not rename an open file.
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Create a new, uniquely named file in `dir`. The name carries nothing of the
/// target's, so no two targets can derive the same one; the process id keeps
/// two processes apart, the counter two threads, and `create_new` turns any
/// leftover from a recycled pid into a retry instead of a shared file.
fn create_temp(dir: &Path, mode: Option<u32>) -> io::Result<(File, PathBuf)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;

    loop {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".atlas-replace-{pid}-{nanos}-{n}.tmp"));
        match options.open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
}

/// `open` applied the umask to the requested mode; this sets it exactly.
#[cfg(unix)]
fn set_mode(file: &File, mode: Option<u32>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    match mode {
        Some(mode) => file.set_permissions(fs::Permissions::from_mode(mode)),
        None => Ok(()),
    }
}

#[cfg(not(unix))]
fn set_mode(_file: &File, _mode: Option<u32>) -> io::Result<()> {
    Ok(())
}
