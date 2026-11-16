/**
 * Reading the Timeline board: the session rows, and the retry that re-fetches
 * the cloud half after it failed.
 */

import { invoke } from "@tauri-apps/api/core";

import type { BoardCheckpoint, BoardPage, ProjectFilter } from "../types";

export function readBoard(projects: string[], filter: ProjectFilter | null): Promise<BoardPage> {
  return invoke<BoardPage>("artifacts_board", { projects, filter });
}

/** Resolves true when the cloud sessions loaded this time. */
export function refreshCloudBoard(): Promise<boolean> {
  return invoke<boolean>("artifacts_cloud_refresh");
}

/** Point the Timeline's cloud half at an organisation and its projects. */
export function retargetCloudBoard(orgId: string | null, projectPaths: string[]): Promise<void> {
  return invoke("artifacts_cloud_retarget", { orgId, projectPaths });
}

/** Every checkpoint across `projects`, for the checkpoint picker. */
export function readCheckpoints(projects: string[]): Promise<BoardCheckpoint[]> {
  return invoke<BoardCheckpoint[]>("artifacts_checkpoints", { projects });
}
