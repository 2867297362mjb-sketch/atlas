// What `App` tells Rust as the window boots and as the open project changes:
// the launch state, the window's own title and zoom, and the per-project
// caches Rust keeps resident (`commands/app_state.rs`, `cli.rs`, `window.rs`,
// `recent_files.rs`, `mention_cache.rs`).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { RecentFile } from "@/features/chat/stores/recent-files-store";

import type { AppStateWire } from "../stores/app-store";

/** The project path the `atlas` CLI launched with, handed over once. */
export function takeInitialCliProjectPath(): Promise<string | null> {
  return invoke<string | null>("cli_take_initial_project_path");
}

/** The only read of `state.json` Atlas performs. */
export function bootstrapAppState(): Promise<AppStateWire> {
  return invoke<AppStateWire>("bootstrap_app_state");
}

/** The `atlas` CLI was run against a window that is already open. */
export function onCliOpenProject(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("atlas:cli-open-project", (event) => handler(event.payload));
}

export function setWindowTitle(title: string): Promise<void> {
  return invoke("set_window_title", { title });
}

/** macOS's titlebar double-click: zoom, as the system setting defines it. */
export function zoomWindow(): Promise<void> {
  return invoke("window_zoom");
}

/** Load the project's recent files and keep them resident. */
export function openRecentFilesProject(
  projectPath: string,
  workspaceId: string | null,
): Promise<RecentFile[]> {
  return invoke<RecentFile[]>("recent_files_open_project", { projectPath, workspaceId });
}

/** No project is open: drop the active recent-files list. */
export function closeRecentFilesProject(): Promise<void> {
  return invoke("recent_files_close_project");
}

/** No project is open: drop the active @-mention cache. */
export function clearMentionCache(): Promise<void> {
  return invoke("mention_cache_clear");
}
