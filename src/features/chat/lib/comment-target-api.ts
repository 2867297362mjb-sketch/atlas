// Which shared session a chat tab's comments belong to
// (`chat_comment_target` in `src-tauri/src/commands/artifacts_cloud.rs`).

import { invoke } from "@tauri-apps/api/core";

import type { CommentTargetIds } from "../stores/chat-comments-store";
import type { AnchorEntry } from "./comment-anchors";

/** The server ids a tab's comments are filed under, with the captured rows
 *  they can anchor to. */
export interface CommentTarget extends CommentTargetIds {
  entries: AnchorEntry[];
}

/** `null` when the session is not shared, or not captured yet. */
export function chatCommentTarget(
  projectPath: string,
  nativeSessionId: string,
): Promise<CommentTarget | null> {
  return invoke<CommentTarget | null>("chat_comment_target", { projectPath, nativeSessionId });
}
