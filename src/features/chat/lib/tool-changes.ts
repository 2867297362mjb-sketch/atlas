// Which files a tool call changed, and by how much: the one reading.
//
// The timeline line, the changed-files viewer, the turn card and its tree all
// ask here. A call can say what it changed in three places, and they are read
// TOGETHER, by content and never by which agent sent the call (ADR-0002):
//
// - its ARGUMENTS, when they carry the edit's text: replaced fragments
//   (`old_string`/`new_string`), a whole file written out (`content`), or the
//   native agent's patch (`{ paths, patch, changes? }`, parsed by
//   `engine-patch.ts`);
// - its DIFF BLOCKS (`content_blocks` of type `diff`), each the whole file
//   before and after;
// - its LOCATIONS, which name a file and say nothing else.
//
// # Precedence, when they disagree
//
// 1. Arguments that carry the edit's text name their files, in their order,
//    with their counts and their kind. Fragments are the exact lines the call
//    replaced; a count taken from two whole files is only an estimate.
// 2. Every file a diff block names is a changed file. For a file the
//    arguments already named, the block supplies the content only (the whole
//    file beats a fragment). Any other file is the block's own, with the
//    block's counts, and is created when the block has no before-text.
// 3. Only when neither produced a file: the path the arguments name, else the
//    first location, with no text and no counts. This is a call still in
//    flight, or one that says where and nothing more.
//
// Arguments and locations are read only for a call that is an edit by its ACP
// `kind` or its tool name; diff blocks make any call an edit. A failed call
// reads like any other: the wire does not say how far it got.

import type { ToolCall } from "@/bindings/agent-wire/ToolCall";
import type { ToolCallDisplay } from "@/types/agent";
import { applyHunks, enginePatchFiles, hunksExcerpt, type EnginePatchFile } from "./engine-patch";
import {
  classifyToolFileKind,
  countChangedLines,
  getEditParts,
  getToolFilePath,
  type EditPart,
} from "./tool-files";

/** What a reading needs of a tool call, as the session-delta wire types it. */
export type ToolCallFacts = Pick<ToolCall, "tool_name" | "kind" | "arguments"> &
  Partial<Pick<ToolCall, "locations" | "content_blocks">>;

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

/** The text of one call's change to one file, in the form the call gave it. */
export type ChangeContent =
  /** The whole file, before and after (a diff block). */
  | { form: "whole"; old: string; new: string }
  /** What the arguments replaced, in order. A part with nothing before it is a
   *  whole file written out. */
  | { form: "parts"; parts: readonly EditPart[] }
  /** The native agent's unified diff of the file. */
  | { form: "hunks"; patch: string }
  /** The whole text of a file the call removed. */
  | { form: "removed"; text: string }
  /** Moved and not edited: nothing to diff. */
  | { form: "moved" };

/** One file one tool call changed. */
export interface FileChange {
  /** As the call named it (usually absolute). A renamed file is named by
   *  where it went. */
  path: string;
  /** Where a renamed file was. */
  previousPath?: string;
  kind: ChangeKind;
  added: number;
  removed: number;
  /** Null when the call named the file but not its text. */
  content: ChangeContent | null;
}

const NO_CHANGES: readonly FileChange[] = Object.freeze([]);

/** Two spellings of one file: equal, or one the other's tail (`src/a.ts`
 *  against `/repo/src/a.ts`). */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function engineChange(file: EnginePatchFile): FileChange {
  const moved = file.movePath ? { previousPath: file.path } : {};
  const kind: ChangeKind = file.movePath
    ? "renamed"
    : file.shape === "content"
      ? "added"
      : file.shape === "deleted"
        ? "deleted"
        : "modified";
  const content: ChangeContent | null =
    file.shape === "hunks"
      ? { form: "hunks", patch: file.text }
      : file.shape === "content"
        ? { form: "parts", parts: [{ old: "", neu: file.text }] }
        : file.shape === "deleted"
          ? { form: "removed", text: file.text }
          : file.shape === "renamed"
            ? { form: "moved" }
            : null;
  return {
    path: file.movePath ?? file.path,
    ...moved,
    kind,
    added: file.added,
    removed: file.removed,
    content,
  };
}

/**
 * The files one tool call changed, in the order it named them. Empty for a
 * call that is not an edit: a read, a search, a command.
 *
 * The header of this file has the precedence between arguments, diff blocks
 * and locations.
 */
export function changesOfToolCall(call: ToolCallFacts): readonly FileChange[] {
  const blocks = call.content_blocks;
  const hasDiff = blocks?.some((b) => b.type === "diff") ?? false;
  const isEdit = classifyToolFileKind(call.kind, call.tool_name) === "edit";
  if (!isEdit && !hasDiff) return NO_CHANGES;

  const args =
    call.arguments && typeof call.arguments === "object"
      ? (call.arguments as Record<string, unknown>)
      : {};
  const out: FileChange[] = [];

  if (isEdit) {
    const parts = getEditParts(call.tool_name, args, call.kind);
    if (parts.length > 0) {
      const path = getToolFilePath(args, call.locations);
      if (path) {
        let added = 0;
        let removed = 0;
        for (const p of parts) {
          const c = countChangedLines(p.old, p.neu);
          added += c.added;
          removed += c.removed;
        }
        out.push({
          path,
          kind: parts.every((p) => p.old === "") ? "added" : "modified",
          added,
          removed,
          content: { form: "parts", parts },
        });
      }
    } else {
      for (const file of enginePatchFiles(args) ?? []) out.push(engineChange(file));
    }
  }

  if (hasDiff) {
    // Each block is the WHOLE file either side, so blocks naming one path
    // collapse to first-before against last-after: the state the call found
    // the file in against the state it left it in. Summing them would count
    // states in between that nobody sees.
    const whole = new Map<string, { old: string; new: string; created: boolean }>();
    for (const b of blocks ?? []) {
      if (b.type !== "diff") continue;
      const seen = whole.get(b.path);
      whole.set(b.path, {
        // The wire OMITS `oldText` for a file the call created; an empty
        // string is a real file that happened to be empty.
        old: seen ? seen.old : (b.oldText ?? ""),
        new: b.newText,
        created: seen ? seen.created : b.oldText === undefined,
      });
    }
    for (const [path, file] of whole) {
      const content: ChangeContent = { form: "whole", old: file.old, new: file.new };
      const named = out.find((c) => samePath(c.path, path));
      if (named?.content) {
        named.content = content;
        continue;
      }
      const counts = countChangedLines(file.old, file.new);
      const kind: ChangeKind = file.created ? "added" : "modified";
      if (!named) {
        out.push({ path, kind, ...counts, content });
        continue;
      }
      // The arguments named the file and nothing of its text.
      named.content = content;
      named.added = counts.added;
      named.removed = counts.removed;
      if (!named.previousPath) named.kind = kind;
    }
  }

  if (out.length === 0 && isEdit) {
    const path = getToolFilePath(args, call.locations);
    if (path) out.push({ path, kind: "modified", added: 0, removed: 0, content: null });
  }
  return out;
}

/** The store's mirror of a tool call, as the wire facts it was built from. */
export function toolCallFacts(tc: ToolCallDisplay): ToolCallFacts {
  return {
    tool_name: tc.toolName,
    kind: tc.kind,
    arguments: tc.arguments,
    locations: tc.locations,
    content_blocks: tc.contentBlocks,
  };
}

const mirrored = new WeakMap<ToolCallDisplay, readonly FileChange[]>();

/**
 * `changesOfToolCall` for a call in the store's message log, read once per
 * call object. The store replaces a call's object whenever a delta changes it
 * and leaves every other call's alone, so a view that re-reads a whole turn
 * on each streaming frame (`projectRows`) pays for the calls that changed and
 * no others. Not for a call inside a store update: a draft is not the object
 * the log will hold.
 */
export function changesOfLoggedCall(tc: ToolCallDisplay): readonly FileChange[] {
  let changes = mirrored.get(tc);
  if (!changes) {
    changes = changesOfToolCall(toolCallFacts(tc));
    mirrored.set(tc, changes);
  }
  return changes;
}

// ── A turn ─────────────────────────────────────────────────────────────────

/** A file's text before and after a turn. */
export interface TurnEdit {
  /** The text before, and after. For an excerpt, only the parts the edits
   *  named; for a `patch`, the hunks' own lines. */
  old: string;
  new: string;
  /**
   * The native engine's unified diff of the file, when that is the turn's
   * only edit to it: hunks with the file's real line numbers, which the
   * viewer renders as they are instead of diffing `old` against `new`. Empty
   * for a file the turn only moved: there is no diff to show.
   */
  patch?: string;
  /** The turn deleted the file. Said outright, because an empty file's
   *  deletion has no text either side to tell it by. */
  deleted?: true;
}

/** One file a turn changed. */
export interface TurnFileChange {
  path: string;
  /** Where the file was before the turn renamed it. Absent for a file the
   *  turn itself created: it had no earlier place. */
  previousPath?: string;
  kind: ChangeKind;
  added: number;
  removed: number;
  /** Null when no call reported the file's text. */
  content: TurnEdit | null;
  /** `content` is only the text the calls replaced, never the whole file:
   *  its line numbers count from the fragment. */
  excerpt: boolean;
}

export interface TurnFoldOptions {
  /**
   * How several calls to one file combine into its kind and counts. The two
   * views that show them were written to different rules, and which is right
   * is the owner's call, so each keeps its own under a name:
   *
   * - `"per-call"` (the default; the turn card): counts are every call's,
   *   added up, so a line rewritten twice counts twice; and a file is `added`
   *   only while every call that touched it wrote it whole.
   * - `"net"` (the changed-files viewer): kind and counts are those of the
   *   text the turn found against the text it left, so a file written and
   *   then edited is `added`, at the size it ended.
   *
   * For a file a single call changed, the two agree.
   */
  combine?: "per-call" | "net";
  /** What two spellings of one file share: the turn's files are keyed, and
   *  named, by it. Defaults to the path as the call gave it. */
  pathKey?: (path: string) => string;
}

/** How one path's argument edits fold, as the turn's calls arrive in order. */
interface TextFold {
  /** The whole file, before and after, while every edit so far has applied
   *  cleanly to a text the turn wrote out whole. Null once one did not. */
  pair: TurnEdit | null;
  /** Every edit's own text, concatenated: the answer when `pair` is lost. */
  concat: TurnEdit;
  /** `concat` holds a fragment, not only whole files. */
  fragmentary: boolean;
  /** The engine's hunks, kept while they are the path's only edit. */
  patch: string | null;
  edits: number;
  /** The last thing the turn did to the file was delete it. */
  deleted: boolean;
}

const newTextFold = (): TextFold => ({
  pair: null,
  concat: { old: "", new: "" },
  fragmentary: false,
  patch: null,
  edits: 0,
  deleted: false,
});

/** A whole file written out. */
function foldWrite(f: TextFold, content: string) {
  f.pair = f.edits === 0 ? { old: "", new: content } : f.pair && { ...f.pair, new: content };
  f.concat = { old: f.concat.old, new: f.concat.new + content };
  f.deleted = false;
  f.edits++;
}

/** A whole file removed, `content` being what it held. */
function foldDelete(f: TextFold, content: string) {
  f.pair = f.edits === 0 ? { old: content, new: "" } : f.pair && { ...f.pair, new: "" };
  f.concat = { old: f.concat.old + content, new: f.concat.new };
  f.deleted = true;
  f.edits++;
}

/** A fragment replaced: applied to the whole file when the turn has it. */
function foldFragment(f: TextFold, old: string, neu: string) {
  if (f.pair) {
    const at = f.pair.new.indexOf(old);
    f.pair =
      at < 0
        ? null
        : { ...f.pair, new: f.pair.new.slice(0, at) + neu + f.pair.new.slice(at + old.length) };
  }
  f.concat = { old: f.concat.old + old, new: f.concat.new + neu };
  f.fragmentary = true;
  f.edits++;
}

/** The engine's hunks: applied to the whole file when the turn has it. */
function foldHunks(f: TextFold, hunks: string) {
  if (f.pair) {
    const applied = applyHunks(f.pair.new, hunks);
    f.pair = applied === null ? null : { ...f.pair, new: applied };
  }
  if (f.edits === 0) f.patch = hunks;
  const excerpt = hunksExcerpt(hunks);
  f.concat = { old: f.concat.old + excerpt.old, new: f.concat.new + excerpt.new };
  f.fragmentary = true;
  f.edits++;
}

/** Everything the turn has done to one path so far. */
interface PathFold {
  /** Where the file was before the turn moved it here. */
  origin?: string;
  /** Every call that touched it so far wrote it whole. */
  created: boolean;
  /** The last call that touched it deleted it. */
  deleted: boolean;
  added: number;
  removed: number;
  /** Whole-file pairs, from diff blocks: first `old` wins, last `new` wins. */
  whole: TurnEdit | null;
  text: TextFold | null;
}

/** The text a path's fold comes to, and whether it is only an excerpt. */
function textOf(fold: PathFold): { content: TurnEdit | null; excerpt: boolean } {
  // A path a diff block reported takes that answer over any other: it is the
  // complete file.
  if (fold.whole) return { content: fold.whole, excerpt: false };
  const text = fold.text;
  if (!text) return { content: null, excerpt: false };
  if (text.deleted && text.pair)
    return { content: { ...text.pair, deleted: true }, excerpt: false };
  if (text.pair) return { content: text.pair, excerpt: false };
  // Moved, never edited: a rename with nothing to diff.
  if (text.edits === 0) return { content: { old: "", new: "", patch: "" }, excerpt: false };
  if (text.edits === 1 && text.patch !== null) {
    return { content: { ...text.concat, patch: text.patch }, excerpt: false };
  }
  return { content: text.concat, excerpt: text.fragmentary };
}

/**
 * What the text itself says happened to the file. Only a whole-file pair can
 * say it was created or deleted, by an empty side; an excerpt or a diff names
 * part of a file that exists either side.
 */
function kindOfText(content: TurnEdit, excerpt: boolean, renamed: boolean): ChangeKind {
  if (content.deleted) return "deleted";
  if (!excerpt && content.patch === undefined) {
    if (content.old === "" && content.new !== "") return "added";
    if (content.new === "" && content.old !== "") return "deleted";
  }
  return renamed ? "renamed" : "modified";
}

/**
 * A turn's changed files, from its calls' changes in the order the agent made
 * them: one entry per file, in the order the turn first touched each.
 *
 * # How a file's text combines
 *
 * - **Whole files** (diff blocks) fold by taking the FIRST before and the
 *   LAST after: the state the turn found the file in, and the state it left
 *   it in. Concatenating them would diff the file against a doubled copy of
 *   itself. A path reported this way takes this answer over any other.
 * - **Parts** are a whole file (nothing before) or a fragment. A fragment
 *   applied to a file this turn wrote out whole is applied for real (a string
 *   replace), so a write then an edit reads as the file the turn left.
 *   Otherwise fragments CONCATENATE into an excerpt, all the record holds.
 * - **Hunks**: a file whose only edit is one diff keeps that diff as it is,
 *   with real line numbers. A diff on a file this turn wrote whole is applied
 *   to it; several diffs to one file otherwise fold into an excerpt.
 * - **Removed** is the file's whole old text against nothing.
 *
 * # Renames
 *
 * A file the turn moved carries on under its new path, in the same place in
 * the list: whatever the turn already did to it under the old path, counts
 * and text, is the new path's. It remembers the EARLIEST path it had, except
 * that a file the turn itself created has no previous path wherever it ends
 * up, and a file moved back to where it started was not renamed.
 */
export function foldChanges(
  changes: Iterable<FileChange>,
  options: TurnFoldOptions = {},
): TurnFileChange[] {
  const key = options.pathKey;
  const folds = new Map<string, PathFold>();
  const order: string[] = [];

  /** Carry what the turn did to `from` over to `to`. False when it had done
   *  nothing there. */
  const move = (from: string, to: string): boolean => {
    const left = folds.get(from);
    if (!left) return false;
    const there = folds.get(to);
    folds.delete(from);
    const origin = left.created ? undefined : (left.origin ?? from);
    folds.set(to, {
      ...(origin !== undefined && origin !== to ? { origin } : {}),
      created: left.created && (there?.created ?? true),
      deleted: false,
      added: left.added + (there?.added ?? 0),
      removed: left.removed + (there?.removed ?? 0),
      whole: there?.whole ?? left.whole,
      text: there?.text ?? left.text,
    });
    const at = order.indexOf(from);
    if (there) order.splice(at, 1);
    else order[at] = to;
    return true;
  };

  for (const change of changes) {
    const path = key ? key(change.path) : change.path;
    const from =
      change.previousPath === undefined
        ? undefined
        : key
          ? key(change.previousPath)
          : change.previousPath;
    const carried = from !== undefined && from !== path && move(from, path);

    let fold = folds.get(path);
    if (!fold) {
      fold = {
        ...(from !== undefined && from !== path ? { origin: from } : {}),
        created: change.kind === "added",
        deleted: false,
        added: 0,
        removed: 0,
        whole: null,
        text: null,
      };
      folds.set(path, fold);
      order.push(path);
    } else if (!carried && change.kind !== "added") {
      // The rename that carried a file here says nothing about whether the
      // turn created it; any other edit to a file means it was there.
      fold.created = false;
    }
    fold.added += change.added;
    fold.removed += change.removed;
    fold.deleted = change.kind === "deleted";

    const content = change.content;
    if (!content) continue;
    if (content.form === "whole") {
      fold.whole = { old: fold.whole ? fold.whole.old : content.old, new: content.new };
      continue;
    }
    const text = (fold.text ??= newTextFold());
    if (content.form === "parts") {
      for (const p of content.parts) {
        if (p.old === "") foldWrite(text, p.neu);
        else foldFragment(text, p.old, p.neu);
      }
    } else if (content.form === "hunks") foldHunks(text, content.patch);
    else if (content.form === "removed") foldDelete(text, content.text);
  }

  const net = options.combine === "net";
  return order.map((path): TurnFileChange => {
    const fold = folds.get(path)!;
    const { content, excerpt } = textOf(fold);
    const renamed = fold.origin !== undefined;
    let kind: ChangeKind = fold.created
      ? "added"
      : fold.deleted
        ? "deleted"
        : renamed
          ? "renamed"
          : "modified";
    let counts = { added: fold.added, removed: fold.removed };
    if (net && content) {
      kind = kindOfText(content, excerpt, renamed);
      // The engine's own diff is counted by its hunks, which is what the
      // calls' counts already are.
      if (content.patch === undefined) counts = countChangedLines(content.old, content.new);
    }
    return {
      path,
      ...(renamed ? { previousPath: fold.origin } : {}),
      kind,
      ...counts,
      content,
      excerpt,
    };
  });
}

/** A turn's changed files, from its tool calls in the order the agent made
 *  them. `foldChanges` has how several calls to one file combine. */
export function changesOfTurn(
  calls: Iterable<ToolCallFacts>,
  options?: TurnFoldOptions,
): TurnFileChange[] {
  const changes: FileChange[] = [];
  for (const call of calls) for (const change of changesOfToolCall(call)) changes.push(change);
  return foldChanges(changes, options);
}
