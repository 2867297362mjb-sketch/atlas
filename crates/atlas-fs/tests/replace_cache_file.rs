//! `replace_cache_file` and `cache_file_present` through their public
//! interface. That the flushes are skipped is not tested here: nothing in a
//! test can see an `fsync` that did not happen.

use std::fs;
use std::path::Path;

use atlas_fs::{cache_file_present, replace_cache_file};

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn replaces_existing_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("avatar-1.png");
    fs::write(&path, "a much longer first version").unwrap();

    replace_cache_file(&path, "second").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "second");
}

#[test]
fn creates_the_file_and_its_missing_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spaces-media").join("ab").join("x.webp");

    replace_cache_file(&path, b"bytes").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"bytes");
}

#[test]
fn leaves_no_temp_file_after_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("only.bin");

    replace_cache_file(&path, "one").unwrap();
    replace_cache_file(&path, "two").unwrap();

    assert_eq!(names_in(dir.path()), ["only.bin"]);
}

#[test]
fn a_failed_write_leaves_no_temp_file_and_the_target_untouched() {
    let dir = tempfile::tempdir().unwrap();
    // A non-empty directory at the target: the temp is written, then the
    // rename over it is refused.
    let target = dir.path().join("track.webm");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), "kept").unwrap();

    assert!(replace_cache_file(&target, "x").is_err());

    assert_eq!(names_in(dir.path()), ["track.webm"]);
    assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "kept");
}

#[test]
fn errors_when_the_path_names_no_file() {
    assert!(replace_cache_file(Path::new("/"), "x").is_err());
}

/// Atomic to a reader in this process's lifetime: the old content or the new,
/// never part of either, and never a missing file between the two.
#[test]
fn a_reader_racing_the_writers_sees_the_old_content_or_the_new() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared.bin");
    // Each payload is one repeated byte, of a different length, so a torn or
    // interleaved file cannot pass for any of them.
    let payloads: Vec<Vec<u8>> = (0..8u8)
        .map(|i| vec![b'a' + i; 32 * 1024 + usize::from(i) * 4096])
        .collect();
    replace_cache_file(&path, &payloads[0]).unwrap();

    std::thread::scope(|scope| {
        for payload in &payloads {
            let path = &path;
            scope.spawn(move || {
                for _ in 0..25 {
                    replace_cache_file(path, payload).unwrap();
                }
            });
        }
        let (path, payloads) = (&path, &payloads);
        scope.spawn(move || {
            for _ in 0..200 {
                let seen = fs::read(path).unwrap();
                assert!(payloads.contains(&seen), "read a torn file");
            }
        });
    });

    let last = fs::read(&path).unwrap();
    assert!(payloads.contains(&last), "the final file is torn");
    assert_eq!(names_in(dir.path()), ["shared.bin"]);
}

#[test]
fn a_cache_file_is_present_only_when_it_is_a_file_with_bytes_in_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("avatar-2.png");
    assert!(!cache_file_present(&path), "missing");

    // What a power cut can leave behind a write that skipped the flush: the
    // name, with nothing in it.
    fs::write(&path, "").unwrap();
    assert!(!cache_file_present(&path), "empty");

    replace_cache_file(&path, "png").unwrap();
    assert!(cache_file_present(&path), "written");

    assert!(!cache_file_present(dir.path()), "a directory");
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// The documented mode: what the platform gives a newly created file
    /// (0o666 less the umask), whatever the replaced file had.
    #[test]
    fn the_new_file_gets_default_permissions_not_the_replaced_files() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh");
        fs::write(&fresh, "x").unwrap();
        let default_mode = mode_of(&fresh);

        let path = dir.path().join("cached");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        // Only meaningful if the default differs from what the old file had.
        assert_ne!(default_mode, 0o600);

        replace_cache_file(&path, "new").unwrap();

        assert_eq!(mode_of(&path), default_mode);
    }
}
