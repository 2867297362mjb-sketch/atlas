// What a permission request proposes to change, as its card draws it: the
// request's own `diff` blocks and the places it names, which travel with it
// (`permission_tool_call` in `atlas-agent-delta`). An agent may send an edit
// as a diff block alone, with nothing in `rawInput`, so a card that drew only
// the input asked for approval of a change it never showed (#33).
//
// The request is agent-controlled JSON forwarded as-is, so every field is
// read through a type check: a malformed block is skipped, never thrown on.

import type { ToolCallRef } from "@/types/acp";

/** One line of an excerpt: unchanged, removed or added. */
export interface PermissionDiffLine {
  sign: " " | "-" | "+";
  text: string;
}

/** One file's proposed change, cut down to the part that changes. */
export interface PermissionDiff {
  path: string;
  added: number;
  removed: number;
  /** The changed lines, with up to `CONTEXT` unchanged ones either side. */
  lines: PermissionDiffLine[];
  /** Lines of the excerpt past `MAX_LINES`, not drawn. */
  more: number;
}

/** Unchanged lines kept either side of the change, so it reads in place. */
const CONTEXT = 2;
/** Lines a card draws per file. The card is pinned above the composer; a
 *  rewritten file would otherwise push the conversation off screen. */
const MAX_LINES = 200;

/** Lines as a diff counts them, the way `countChangedLines` does: an empty
 *  side is no lines, and a trailing newline ends the last line. */
const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * The change between two whole texts, as the region between their common
 * first and last lines. The same reading — and so the same counts — as
 * `countChangedLines`, which sizes the edit on its tool row.
 */
function excerpt(path: string, before: string, after: string): PermissionDiff {
  const o = linesOf(before);
  const n = linesOf(after);
  let start = 0;
  while (start < o.length && start < n.length && o[start] === n[start]) start++;
  let eo = o.length;
  let en = n.length;
  while (eo > start && en > start && o[eo - 1] === n[en - 1]) {
    eo--;
    en--;
  }
  const lines: PermissionDiffLine[] = [
    ...n.slice(Math.max(0, start - CONTEXT), start).map((text) => ({ sign: " " as const, text })),
    ...o.slice(start, eo).map((text) => ({ sign: "-" as const, text })),
    ...n.slice(start, en).map((text) => ({ sign: "+" as const, text })),
    ...n.slice(en, en + CONTEXT).map((text) => ({ sign: " " as const, text })),
  ];
  return {
    path,
    added: en - start,
    removed: eo - start,
    lines: lines.slice(0, MAX_LINES),
    more: Math.max(0, lines.length - MAX_LINES),
  };
}

/** The request's proposed edits, one per well-formed `diff` block. */
export function permissionDiffsOf(toolCall: ToolCallRef): PermissionDiff[] {
  const blocks = toolCall.contentBlocks;
  if (!Array.isArray(blocks)) return [];
  const out: PermissionDiff[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const { type, path, oldText, newText } = block as Record<string, unknown>;
    if (type !== "diff" || typeof path !== "string" || !path || typeof newText !== "string") {
      continue;
    }
    // The wire leaves `oldText` out for a file the call creates.
    if (oldText !== undefined && typeof oldText !== "string") continue;
    out.push(excerpt(path, oldText ?? "", newText));
  }
  return out;
}

/** The places the request names, as `path` or `path:line`, leaving out the
 *  files a diff already shows. */
export function permissionLocationsOf(
  toolCall: ToolCallRef,
  diffs: readonly PermissionDiff[],
): string[] {
  const raw = toolCall.locations;
  if (!Array.isArray(raw)) return [];
  const shown = new Set(diffs.map((d) => d.path));
  const out: string[] = [];
  for (const location of raw) {
    if (!location || typeof location !== "object") continue;
    const { path, line } = location as Record<string, unknown>;
    if (typeof path !== "string" || !path || shown.has(path)) continue;
    out.push(typeof line === "number" && Number.isInteger(line) ? `${path}:${line}` : path);
  }
  return out;
}
