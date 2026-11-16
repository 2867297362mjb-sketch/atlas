//! Per-project UI session persistence — `<project>/.atlas/session.json`.
//!
//! Holds whatever the frontend's session store needs to restore a project the
//! way the user left it (open tabs, layout, selection). Atlas writes it on
//! change and reads it during the boot cascade.
//!
//! Both commands are async + `spawn_blocking` for the same reason every other
//! fs-touching Tauri command here is: a sync handler runs on the NSApp main
//! thread and freezes the UI while the syscall blocks. `load_project_session`
//! is part of the boot cascade — its previous sync form was contributing to the
//! warm-start beachball.
//!
//! (These lived in `commands::research` until that module was deleted; they were
//! never research-specific.)

use std::fs;
use std::path::Path;

#[tauri::command]
pub async fn save_project_session(
    project_path: String,
    session_data: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = atlas_profile::dir_in(Path::new(&project_path));
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
        let session_path = atlas_dir.join("session.json");
        fs::write(&session_path, &session_data).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn load_project_session(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let session_path = atlas_profile::dir_in(Path::new(&project_path)).join("session.json");
        if session_path.exists() {
            fs::read_to_string(&session_path).map_err(|e| e.to_string())
        } else {
            // A project with no saved session is the normal first-open case,
            // not an error — the frontend treats `{}` as "use defaults".
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// The file is the frontend's: Rust keeps the string it was handed and
    /// gives the same bytes back, so nothing in it can be dropped or renamed
    /// here. A project never saved answers `{}`.
    #[tokio::test]
    async fn a_session_is_returned_byte_for_byte_after_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        let saved = r#"{"version":3,"tabs":[{"id":"t1","kind":"chat"}],"unknown":{"kept":true}}"#;

        tokio::time::timeout(Duration::from_secs(10), async {
            assert_eq!(load_project_session(project.clone()).await.unwrap(), "{}");
            save_project_session(project.clone(), saved.to_string())
                .await
                .unwrap();
            assert_eq!(load_project_session(project).await.unwrap(), saved);
        })
        .await
        .expect("the session commands did not finish");
    }
}
