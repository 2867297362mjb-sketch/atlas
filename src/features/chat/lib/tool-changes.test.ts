// The one reading of what a tool call changed, over the shared fixture set:
// each call's files, then the turn's, under both ways calls combine.

import { describe, expect, it } from "vitest";
import {
  changesOfToolCall,
  changesOfTurn,
  foldChanges,
  type FileChange,
  type TurnFileChange,
} from "./tool-changes";
import { toRepoRelative } from "./open-turn-diff";
import { FIXTURES, REPO, fixture } from "./tool-changes.fixtures";

const rel = (path: string) => toRepoRelative(path, REPO);
const was = (c: { previousPath?: string }) =>
  c.previousPath === undefined ? "" : ` (was ${rel(c.previousPath)})`;

/** One call's change, on one line. */
const line = (c: FileChange) =>
  `${c.kind} ${rel(c.path)}${was(c)} +${c.added} −${c.removed} ${c.content?.form ?? "no text"}`;

/** A turn's file, on one line: `patch` is the engine's own diff, kept. */
const turnLine = (c: TurnFileChange) => {
  const text = !c.content
    ? "no text"
    : c.excerpt
      ? "excerpt"
      : c.content.patch !== undefined
        ? "patch"
        : "whole";
  return `${c.kind} ${c.path}${was(c)} +${c.added} −${c.removed} ${text}`;
};

const pathKey = rel;

interface Row {
  /** Each call's changes. */
  calls: string[][];
  /** The turn's files, calls combined per call. */
  turn: string[];
  /** The same, combined net; given only where it differs. */
  net?: string[];
}

const EXPECTED: Record<string, Row> = {
  "edit with a path in its arguments and a diff block": {
    // The arguments' counts and kind, the block's whole file.
    calls: [["modified src/session.ts +1 −0 whole"]],
    turn: ["modified src/session.ts +1 −0 whole"],
  },
  "diff block only": {
    calls: [["modified src/app.ts +2 −1 whole"]],
    turn: ["modified src/app.ts +2 −1 whole"],
  },
  "diff block only, classed as an edit with a location": {
    calls: [["modified src/app.ts +2 −1 whole"]],
    turn: ["modified src/app.ts +2 −1 whole"],
  },
  "diff block that creates a file": {
    calls: [["added src/new.ts +2 −0 whole"]],
    turn: ["added src/new.ts +2 −0 whole"],
  },
  "arguments only, still running": {
    calls: [["modified src/auth.ts +2 −1 parts"]],
    turn: ["modified src/auth.ts +2 −1 excerpt"],
  },
  "native edit, still running": {
    calls: [["modified src/lib.rs +0 −0 no text"]],
    turn: ["modified src/lib.rs +0 −0 no text"],
  },
  "native patch naming several files": {
    calls: [["modified src/a.rs +1 −0 hunks", "added src/new.rs +2 −0 parts"]],
    turn: ["modified src/a.rs +1 −0 patch", "added src/new.rs +2 −0 whole"],
  },
  "native rename": {
    calls: [["renamed src/d.rs (was src/c.rs) +0 −0 moved"]],
    turn: ["renamed src/d.rs (was src/c.rs) +0 −0 patch"],
  },
  "native rename plus edit": {
    calls: [["renamed src/d.rs (was src/c.rs) +1 −1 hunks"]],
    turn: ["renamed src/d.rs (was src/c.rs) +1 −1 patch"],
  },
  "native delete": {
    calls: [["deleted src/gone.rs +0 −1 removed"]],
    turn: ["deleted src/gone.rs +0 −1 whole"],
  },
  "create, named by its title": {
    calls: [["added src/x.ts +3 −0 parts"]],
    turn: ["added src/x.ts +3 −0 whole"],
  },
  "the same file edited twice": {
    calls: [["modified src/a.ts +1 −1 parts"], ["modified src/a.ts +2 −1 parts"]],
    turn: ["modified src/a.ts +3 −2 excerpt"],
  },
  "a file written, then edited": {
    calls: [["added src/w.ts +2 −0 parts"], ["modified src/w.ts +1 −1 parts"]],
    // Per call: an edit means the file was there, and both calls count.
    turn: ["modified src/w.ts +3 −1 whole"],
    // Net: nothing before, two lines after.
    net: ["added src/w.ts +2 −0 whole"],
  },
  "a file edited, then renamed": {
    calls: [["modified src/c.rs +1 −1 hunks"], ["renamed src/d.rs (was src/c.rs) +1 −1 hunks"]],
    turn: ["renamed src/d.rs (was src/c.rs) +2 −2 excerpt"],
  },
  "a file created, then renamed": {
    calls: [["added src/c.rs +1 −0 parts"], ["renamed src/d.rs (was src/c.rs) +1 −1 hunks"]],
    // Created by the turn, so it has no previous path under either rule.
    turn: ["added src/d.rs +2 −1 whole"],
    net: ["added src/d.rs +1 −0 whole"],
  },
  "a failed edit": {
    // A failed call reads like any other.
    calls: [["modified src/a.ts +1 −1 parts"]],
    turn: ["modified src/a.ts +1 −1 excerpt"],
  },
  "locations only": {
    calls: [["modified src/loc.ts +0 −0 no text"]],
    turn: ["modified src/loc.ts +0 −0 no text"],
  },
  "a diff block beside arguments naming another file": {
    // The file the arguments name first, then the one only the block names.
    calls: [["added src/known.ts +1 −0 parts", "added src/other.ts +1 −0 whole"]],
    turn: ["added src/known.ts +1 −0 whole", "added src/other.ts +1 −0 whole"],
  },
  "a read, a search and a command": {
    calls: [[], [], []],
    turn: [],
  },
};

describe("what a tool call changed", () => {
  it("has an expectation for every fixture", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(FIXTURES.map((f) => f.name).sort());
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))("%s", (name, { calls }) => {
    const row = EXPECTED[name];
    expect(calls.map((c) => changesOfToolCall(c).map(line))).toEqual(row.calls);
    expect(changesOfTurn(calls, { pathKey }).map(turnLine)).toEqual(row.turn);
    expect(changesOfTurn(calls, { pathKey, combine: "net" }).map(turnLine)).toEqual(
      row.net ?? row.turn,
    );
  });
});

describe("precedence between arguments, diff blocks and locations", () => {
  const { calls } = fixture("edit with a path in its arguments and a diff block");
  const both = calls[0];

  it("counts by the arguments when they carry the text, whatever the block spans", () => {
    // Two edits far apart: the fragments say two lines, and the two whole
    // files, trimmed to what differs, would say everything between them.
    const before = "a\nb\nc\nd\ne\n";
    const [change] = changesOfToolCall({
      tool_name: "MultiEdit",
      kind: "edit",
      arguments: {
        file_path: "/repo/x.ts",
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "e", new_string: "E" },
        ],
      },
      content_blocks: [
        { type: "diff", path: "/repo/x.ts", oldText: before, newText: "A\nb\nc\nd\nE\n" },
      ],
    });
    expect([change.added, change.removed]).toEqual([2, 2]);
    expect(change.content).toEqual({ form: "whole", old: before, new: "A\nb\nc\nd\nE\n" });
  });

  it("takes one file for a path the arguments and a block spell differently", () => {
    const changes = changesOfToolCall({
      ...both,
      arguments: { file_path: "src/session.ts", old_string: "a", new_string: "b" },
    });
    expect(changes.map((c) => c.path)).toEqual(["src/session.ts"]);
    expect(changes[0].content?.form).toBe("whole");
  });

  it("lets the block name the file when the arguments carry no text", () => {
    // The arguments name a path and nothing of the edit, and the block names
    // the file its own way: the path alone is only a fallback.
    const changes = changesOfToolCall({
      tool_name: "apply_patch",
      kind: "edit",
      arguments: { path: "session.ts" },
      locations: [{ path: "/elsewhere/session.ts" }],
      content_blocks: [{ type: "diff", path: "/repo/src/app.ts", oldText: "a\n", newText: "b\n" }],
    });
    expect(changes.map(line)).toEqual(["modified src/app.ts +1 −1 whole"]);
  });

  it("folds blocks naming one file to its first before against its last after", () => {
    const [change] = changesOfToolCall({
      tool_name: "apply_patch",
      kind: null,
      arguments: {},
      content_blocks: [
        { type: "diff", path: "/repo/a.ts", oldText: "a\n", newText: "b\n" },
        { type: "diff", path: "/repo/a.ts", oldText: "b\n", newText: "c\n" },
      ],
    });
    expect(line(change)).toBe("modified a.ts +1 −1 whole");
    expect(change.content).toEqual({ form: "whole", old: "a\n", new: "c\n" });
  });

  it("reads arguments and locations only for a call that is an edit", () => {
    const args = { file_path: "/repo/a.ts", old_string: "a", new_string: "b" };
    expect(changesOfToolCall({ tool_name: "mystery", kind: "other", arguments: args })).toEqual([]);
    expect(
      changesOfToolCall({ tool_name: "mystery", kind: "edit", arguments: args }).map(line),
    ).toEqual(["modified a.ts +1 −1 parts"]);
  });

  it("reads an existing file that was empty as modified, not created", () => {
    const [change] = changesOfToolCall({
      tool_name: "apply_patch",
      kind: null,
      arguments: {},
      content_blocks: [{ type: "diff", path: "/repo/e.ts", oldText: "", newText: "now\n" }],
    });
    expect(change.kind).toBe("modified");
  });
});

describe("how a turn's renames fold", () => {
  const change = (over: Partial<FileChange> & Pick<FileChange, "path">): FileChange => ({
    kind: "modified",
    added: 1,
    removed: 1,
    content: null,
    ...over,
  });
  const move = (from: string, to: string) =>
    change({ path: to, previousPath: from, kind: "renamed", added: 0, removed: 0 });

  it("keeps the earliest path through a chain of renames", () => {
    const [file] = foldChanges([change({ path: "a" }), move("a", "b"), move("b", "c")]);
    expect([file.path, file.previousPath, file.added]).toEqual(["c", "a", 1]);
  });

  it("is not a rename when the file ends where it started", () => {
    const [file] = foldChanges([change({ path: "a" }), move("a", "b"), move("b", "a")]);
    expect([file.path, file.previousPath, file.kind]).toEqual(["a", undefined, "modified"]);
  });

  it("keeps the renamed file's place in the turn's order", () => {
    const files = foldChanges([change({ path: "a" }), change({ path: "z" }), move("a", "b")]);
    expect(files.map((f) => f.path)).toEqual(["b", "z"]);
  });

  it("is one file when a rename lands on a path the turn already changed", () => {
    const files = foldChanges([change({ path: "a" }), change({ path: "b" }), move("a", "b")]);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([["b", 2, 2]]);
  });

  it("names a file the turn never touched before by where it was", () => {
    const [file] = foldChanges([move("a", "b")]);
    expect([file.path, file.previousPath, file.kind]).toEqual(["b", "a", "renamed"]);
  });
});
