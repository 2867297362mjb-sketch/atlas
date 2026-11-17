use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Per-node {x, y} world coordinates from the last graph session, so
/// the layout survives tab switches AND full app restarts. Stored at
/// `.atlas/knowledge-graph-layout.json` so it lives next to the rest
/// of the per-project Atlas state.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct GraphLayout {
    pub positions: HashMap<String, Pos>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy)]
pub struct Pos {
    pub x: f64,
    pub y: f64,
}

fn layout_path(project_path: &str) -> std::path::PathBuf {
    atlas_profile::dir_in(Path::new(project_path)).join("knowledge-graph-layout.json")
}

#[tauri::command]
pub async fn knowledge_graph_layout_load(project_path: String) -> Result<GraphLayout, String> {
    tokio::task::spawn_blocking(move || -> Result<GraphLayout, String> {
        let p = layout_path(&project_path);
        if !p.exists() {
            return Ok(GraphLayout::default());
        }
        let raw = fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str::<GraphLayout>(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_graph_layout_save(
    project_path: String,
    layout: GraphLayout,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let final_path =
            atlas_profile::dir_in(Path::new(&project_path)).join("knowledge-graph-layout.json");
        let payload = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
        atlas_fs::replace_file(&final_path, &payload).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_saved_layout_loads_back_and_leaves_only_its_file() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        let layout = |x: f64| GraphLayout {
            positions: HashMap::from([("note".to_string(), Pos { x, y: 2.0 })]),
        };

        // The first save is also the one that creates the profile directory.
        knowledge_graph_layout_save(root.clone(), layout(1.0))
            .await
            .unwrap();
        knowledge_graph_layout_save(root.clone(), layout(7.5))
            .await
            .unwrap();

        let loaded = knowledge_graph_layout_load(root).await.unwrap();
        assert_eq!(loaded.positions.len(), 1);
        assert_eq!(loaded.positions["note"].x, 7.5);
        assert_eq!(loaded.positions["note"].y, 2.0);
        assert_eq!(
            crate::commands::file_names_in(&atlas_profile::dir_in(project.path())),
            ["knowledge-graph-layout.json"]
        );
    }
}
