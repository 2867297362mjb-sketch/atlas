// The OS clipboard as files (`src-tauri/src/commands/clipboard.rs`), for the
// composers that paste them.

import { invoke } from "@tauri-apps/api/core";

/** Absolute paths of the files on the clipboard (a Finder or Explorer copy). */
export function clipboardFilePaths(): Promise<string[]> {
  return invoke<string[]>("clipboard_file_paths");
}

/** Linux: the copied files, else a clipboard image spooled to a scratch file. */
export function clipboardPastePaths(): Promise<string[]> {
  return invoke<string[]>("clipboard_paste_paths");
}
