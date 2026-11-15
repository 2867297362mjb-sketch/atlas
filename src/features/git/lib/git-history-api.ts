// Reading history: the commit graph and one commit's contents
// (`src-tauri/src/commands/git.rs`, `capture.rs`).

import { invoke } from "@tauri-apps/api/core";

import type { CommitSession } from "../components/commit-view";
import type { CommitDetail } from "../stores/git-store";
import type { BuiltGraph } from "./git-graph";

/** Changes whenever a ref moves, so it keys the graph query. */
export function gitGraphSignature(path: string): Promise<string> {
  return invoke<string>("git_graph_signature", { path });
}

/** The graph of every ref, newest first, up to `limit` commits. */
export function gitGraphBuild(path: string, limit: number): Promise<BuiltGraph> {
  return invoke<BuiltGraph>("git_graph_build", { path, limit, all: true });
}

export function gitShow(
  path: string,
  sha: string,
  ignoreWhitespace: boolean,
): Promise<CommitDetail> {
  return invoke<CommitDetail>("git_show", { path, sha, ignoreWhitespace });
}

/** The captured sessions linked to a commit. */
export function commitSessions(projectPath: string, commitSha: string): Promise<CommitSession[]> {
  return invoke<CommitSession[]>("capture_commit_sessions", { projectPath, commitSha });
}
