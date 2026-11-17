// The turn card's record of a turn: the files its tool calls read or changed,
// as `TurnFile`s. What a call CHANGED is the one reading's answer
// (`tool-changes.ts`); this file only restates it in the card's shape and
// adds what a call read.
//
// One builder for the live accumulator (`tool_call_upserted`) and the
// transcript reconstruction (`reconstructTurnSummaries`), so a resumed session
// and a live one cannot disagree about what a call did.

import type { TurnFile } from "@/types/agent";
import {
  changesOfToolCall,
  foldChanges,
  type ChangeKind,
  type FileChange,
  type ToolCallFacts,
} from "./tool-changes";
import { classifyToolFileKind, getToolFilePath } from "./tool-files";

/** A change, as the card keeps it. The card has no word for a deleted file:
 *  it is an edit that removed lines. */
function toTurnFile(change: {
  path: string;
  previousPath?: string;
  kind: ChangeKind;
  added: number;
  removed: number;
}): TurnFile {
  return {
    path: change.path,
    kind: "edit",
    added: change.added,
    removed: change.removed,
    created: change.kind === "added",
    ...(change.previousPath !== undefined ? { movedFrom: change.previousPath } : {}),
  };
}

/** The card's record of an edit, back as the change it restates. */
function toChange(file: TurnFile): FileChange {
  return {
    path: file.path,
    ...(file.movedFrom !== undefined ? { previousPath: file.movedFrom } : {}),
    kind: file.created ? "added" : file.movedFrom !== undefined ? "renamed" : "modified",
    added: file.added,
    removed: file.removed,
    content: null,
  };
}

/**
 * The files a tool call touched, as the per-turn record keeps them: every
 * file it changed, else the file it read. Empty when the call is about no
 * file.
 */
export function turnFilesOfToolCall(call: ToolCallFacts): TurnFile[] {
  const changes = changesOfToolCall(call);
  if (changes.length > 0) return changes.map(toTurnFile);
  if (classifyToolFileKind(call.kind, call.tool_name) !== "read") return [];
  const args =
    call.arguments && typeof call.arguments === "object"
      ? (call.arguments as Record<string, unknown>)
      : {};
  const path = getToolFilePath(args, call.locations);
  return path ? [{ path, kind: "read", added: 0, removed: 0, created: undefined }] : [];
}

/**
 * A turn's files, one entry per path, from each call's files in the order
 * the turn made them. Edits fold as `foldChanges` folds them (counts summed,
 * a rename carried to where the file went); a file the turn only read
 * follows them. A file the turn read before it wrote it was there already,
 * so it is not one the turn created.
 */
export function foldTurnFiles(files: Iterable<TurnFile>): TurnFile[] {
  const reads = new Set<string>();
  const existed = new Set<string>();
  const changed = new Set<string>();
  const changes: FileChange[] = [];
  for (const file of files) {
    if (file.kind === "read") {
      reads.add(file.path);
      if (!changed.has(file.path)) existed.add(file.path);
      continue;
    }
    changed.add(file.path);
    if (file.movedFrom !== undefined) changed.add(file.movedFrom);
    changes.push(toChange(file));
  }
  const out = foldChanges(changes).map((change) => {
    const file = toTurnFile(change);
    if (existed.has(file.path)) file.created = false;
    return file;
  });
  for (const path of reads) {
    if (!changed.has(path)) out.push({ path, kind: "read", added: 0, removed: 0 });
  }
  return out;
}
