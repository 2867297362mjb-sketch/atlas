// The git watcher (`src-tauri/src/commands/git_watcher.rs`): starting it for
// a project, and hearing what it saw.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { GitChangedPayload } from "./git-changed-events";

/** Keep a watcher resident for the project; idempotent for a live one. */
export function startGitWatch(projectPath: string, workspaceId: string | null): Promise<void> {
  return invoke("git_watch_start", { projectPath, workspaceId });
}

/** A commit, checkout, stage or other change landed under `payload.project`. */
export function onGitChanged(handler: (payload: GitChangedPayload) => void): Promise<UnlistenFn> {
  return listen<GitChangedPayload>("atlas:git-changed", (event) => handler(event.payload));
}
