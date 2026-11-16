import type { ChatMessage } from "@/types/agent";
import { toRepoRelative } from "./open-turn-diff";
import { changesOfLoggedCall, foldChanges, type FileChange, type TurnEdit } from "./tool-changes";
import { findTurnRun, isEmptyMessage, stableTurnKey, type TurnRun } from "./turn-identity";

export type { TurnEdit };

export interface TurnEdits {
  /** Files the turn changed, in the order it first touched them. */
  files: string[];
  /** Which file the viewer should land on. */
  initial: string;
  sources: Record<string, TurnEdit>;
  /**
   * Files whose pair is only the text the agent replaced, never the whole
   * file: an `Edit` names a fragment. Their diff is an excerpt, its line
   * numbers count from the fragment, and the viewer says so.
   */
  excerpts: ReadonlySet<string>;
  /** A renamed file's previous path, by the path it went to (the one in
   *  `files`). Absent when nothing was renamed. */
  renames?: Readonly<Record<string, string>>;
}

/** The changes of every call in `run`, in order. */
function* changesIn(messages: ChatMessage[], run: TurnRun): Generator<FileChange> {
  for (let i = run.start; i < run.end; i++) {
    for (const tc of messages[i].toolCalls) yield* changesOfLoggedCall(tc);
  }
}

/**
 * The before/after text a single turn produced, per file.
 *
 * Walks the turn's assistant run — `turnId` names any message of it, by its
 * transcript id or its stable key (`findTurnRun`) — and asks the one reading
 * of what its calls changed (`tool-changes.ts`), which folds every edit to a
 * path into one answer, so a turn that touched a file three times reads as
 * one diff rather than three competing ones. `foldChanges` has how.
 *
 * Only a file whose text some call reported is here: there is nothing to
 * diff for one a call merely named (still in flight, or named by its location
 * alone). A file another agent deleted (`rm`, a command) contributes no edit
 * at all and simply does not appear: nothing recorded its text.
 */
export function collectTurnEdits(
  messages: ChatMessage[],
  turnId: string,
  repoPath: string,
  preferredFile?: string,
): TurnEdits {
  const run = findTurnRun(messages, turnId);
  const files: string[] = [];
  const sources: Record<string, TurnEdit> = {};
  const excerpts = new Set<string>();
  const renames: Record<string, string> = {};
  const changes = run
    ? foldChanges(changesIn(messages, run), {
        combine: "net",
        pathKey: (path) => toRepoRelative(path, repoPath),
      })
    : [];
  for (const change of changes) {
    if (!change.content) continue;
    files.push(change.path);
    sources[change.path] = change.content;
    if (change.excerpt) excerpts.add(change.path);
    if (change.previousPath !== undefined) renames[change.path] = change.previousPath;
  }

  // The row that was clicked may name the file by the path it had before
  // the turn renamed it.
  let wanted = preferredFile ? toRepoRelative(preferredFile, repoPath) : "";
  if (wanted && !sources[wanted]) {
    wanted = Object.keys(renames).find((to) => renames[to] === wanted) ?? wanted;
  }
  return {
    files,
    initial: wanted && sources[wanted] ? wanted : (files[0] ?? ""),
    sources,
    excerpts,
    ...(Object.keys(renames).length > 0 ? { renames } : {}),
  };
}

/** One turn of a session that changed files, as the turn picker lists it. */
export interface EditTurn {
  /** The turn's stable key (`stableTurnKey`), which outlives a reload of the
   *  log, unlike the transcript's `t:` id. */
  turnId: string;
  /** 1-based, counting every turn of the session, so a number stays put
   *  when an earlier turn changed nothing. */
  number: number;
  /** When the turn's last message arrived: when it finished, once it has. */
  timestamp: string;
  /** The prompt the turn answered, on one line; empty when there was none. */
  prompt: string;
  /** How many files it changed. */
  fileCount: number;
}

/** A prompt's snippet runs to this many characters before an ellipsis. */
export const PROMPT_SNIPPET_CHARS = 60;

/** The prompt's prose (without its @-mention context), on one line. */
function snippetOf(message: ChatMessage | undefined): string {
  if (!message || message.role !== "user") return "";
  const prose = (message.atlasProse ?? message.content).replace(/\s+/g, " ").trim();
  return prose.length > PROMPT_SNIPPET_CHARS
    ? `${prose.slice(0, PROMPT_SNIPPET_CHARS - 1).trimEnd()}…`
    : prose;
}

/** A change with its text left behind: the fold still learns the file has
 *  some, and concatenates none of it. */
const MOVED = { form: "moved" } as const;
function* withoutText(changes: Iterable<FileChange>): Generator<FileChange> {
  for (const change of changes) yield change.content ? { ...change, content: MOVED } : change;
}

/**
 * Every turn of the session that changed a file, newest first.
 *
 * A turn is the run of assistant messages that answers a prompt, the same
 * run `collectTurnEdits` walks, so a listed turn always has edits to show. A
 * run of nothing but empty messages is no turn, as in the transcript.
 * Only paths are collected here; the texts are `collectTurnEdits`' job, for
 * the one turn the reader picks.
 */
export function listEditTurns(messages: ChatMessage[], repoPath: string): EditTurn[] {
  const out: EditTurn[] = [];
  let number = 0;
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== "assistant") {
      i++;
      continue;
    }
    const run: TurnRun = { start: i, end: i };
    let shown = false;
    for (; i < messages.length && messages[i].role === "assistant"; i++) {
      if (!isEmptyMessage(messages[i])) shown = true;
    }
    run.end = i;
    if (!shown) continue;
    number += 1;
    // The files `collectTurnEdits` would list: those with text to show.
    const pathKey = (path: string) => toRepoRelative(path, repoPath);
    let fileCount = 0;
    for (const change of foldChanges(withoutText(changesIn(messages, run)), { pathKey })) {
      if (change.content) fileCount++;
    }
    const key = fileCount > 0 ? stableTurnKey(messages, run) : null;
    if (!key) continue;
    out.push({
      turnId: key,
      number,
      timestamp: messages[i - 1].timestamp,
      prompt: snippetOf(messages[run.start - 1]),
      fileCount,
    });
  }
  return out.reverse();
}

/**
 * A cheap key that changes whenever a session's edits might have: a message
 * arrived, or any tool call was upserted, in whichever message
 * (`toolRevision`, which the store bumps). The last message's calls are in it
 * too, for a log changed without a delta (a test, a restore). Streamed prose
 * leaves it alone, so a view keyed on it does not re-render per chunk.
 */
export function editsSignature(
  messages: readonly ChatMessage[] | undefined,
  toolRevision = 0,
): string {
  if (!messages || messages.length === 0) return "";
  const last = messages[messages.length - 1];
  let calls = "";
  for (const tc of last.toolCalls) calls += `${tc.status[0]}${tc.contentBlocks?.length ?? 0}`;
  return `${messages.length}:${last.id}:${toolRevision}:${calls}`;
}
