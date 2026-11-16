import { describe, expect, it } from "vitest";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { parseDiff } from "./diff";
import cases from "./unified-diff.fixtures.json";

/**
 * Atlas reads `git diff` output in more than one place, in two languages:
 *
 *   - `parseDiff` here, for the changes view and the commit view;
 *   - `@pierre/diffs`, for the review diff (`getRenderablePatch`);
 *   - `atlas-gitdiff` in Rust, for the editor gutter;
 *   - `atlas_git::patch` in Rust, for hunk and line staging, which must find
 *     the hunk `parseDiff` displayed in a fresh diff, line for line.
 *
 * `unified-diff.fixtures.json` is what holds them to one reading. Each case
 * is a diff as git printed it (`synthetic` marks the few git never prints)
 * and `files`, what it says: a hunk line is its marker (` `, `+`, `-`) and
 * its text, a `\r` included. This suite reads it for the two TypeScript
 * parsers; the tests modules of `crates/atlas-gitdiff/src/parse.rs` and
 * `crates/atlas-git/src/patch.rs` read it for the Rust ones.
 *
 * A parser that reads a case differently is listed in its `DIFFERS` table
 * with what it answers instead, so a disagreement is written down, and
 * fixing one fails here until its entry is removed.
 */

interface FixtureHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}
interface FixtureFile {
  path: string;
  oldPath?: string;
  binary?: boolean;
  hunks: FixtureHunk[];
}

type Reading = FixtureFile[] | "throws";

function read(parse: () => FixtureFile[]): Reading {
  try {
    return parse();
  } catch {
    return "throws";
  }
}

const MARKER = { add: "+", remove: "-", context: " " } as const;

function ownReading(diff: string): FixtureFile[] {
  return parseDiff(diff).map((file) => ({
    path: file.path,
    ...(file.oldPath && { oldPath: file.oldPath }),
    ...(file.binary && { binary: true }),
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line) => MARKER[line.type] + line.content),
    })),
  }));
}

const withoutNewline = (line: string) => line.replace(/\n$/, "");

function libraryFile(file: FileDiffMetadata): FixtureFile {
  return {
    path: file.name,
    ...(file.prevName && { oldPath: file.prevName }),
    hunks: file.hunks.map((hunk) => {
      const lines: string[] = [];
      for (const part of hunk.hunkContent) {
        if (part.type === "context") {
          for (let i = 0; i < part.lines; i++)
            lines.push(` ${withoutNewline(file.additionLines[part.additionLineIndex + i])}`);
          continue;
        }
        for (let i = 0; i < part.deletions; i++)
          lines.push(`-${withoutNewline(file.deletionLines[part.deletionLineIndex + i])}`);
        for (let i = 0; i < part.additions; i++)
          lines.push(`+${withoutNewline(file.additionLines[part.additionLineIndex + i])}`);
      }
      return { oldStart: hunk.deletionStart, newStart: hunk.additionStart, lines };
    }),
  };
}

function libraryReading(diff: string): FixtureFile[] {
  return parsePatchFiles(diff, "fixtures", true)
    .flatMap((patch) => patch.files)
    .map(libraryFile);
}

type Differs = Record<string, (files: FixtureFile[]) => Reading>;

const unknownPath = (files: FixtureFile[]) => files.map((file) => ({ ...file, path: "unknown" }));

const OWN_DIFFERS: Differs = {
  // The path is read from `diff --git a/… b/…` alone, unquoted names only.
  "quoted-path-utf8": unknownPath,
  "quoted-path-tab": unknownPath,
  "mnemonic-prefix": unknownPath,
  "no-prefix": unknownPath,
  // Neither `diff --cc` nor `@@@` is recognised: a conflicted file has no lines.
  "combined-merge": () => [{ path: "unknown", hunks: [] }],
  // Only the one-line `Binary files … differ` summary marks a file binary.
  "binary-patch": (files) => files.map(({ binary: _binary, ...file }) => file),
  // A line with no marker is dropped, and the line numbers after it are off by one.
  "stripped-blank-context": (files) =>
    files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.filter((l) => l !== " ") })),
    })),
};

// The review diff shows the raw patch when the library throws.
const LIBRARY_DIFFERS: Differs = {
  "mnemonic-prefix": () => "throws",
  "no-prefix": () => "throws",
  "combined-merge": () => "throws",
  "stripped-blank-context": () => "throws",
};

describe("the shared unified-diff fixtures", () => {
  it("cover the shapes git prints", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  describe("parseDiff", () => {
    it.each(cases)("$name", ({ name, diff, files }) => {
      expect(read(() => ownReading(diff))).toEqual(OWN_DIFFERS[name]?.(files) ?? files);
    });

    it("lists only cases it still reads differently", () => {
      for (const [name, differs] of Object.entries(OWN_DIFFERS)) {
        const files = cases.find((c) => c.name === name)?.files;
        expect(files && differs(files), name).not.toEqual(files);
      }
    });
  });

  // The library has no notion of a binary file: one is a file with no hunks.
  describe("@pierre/diffs", () => {
    const expected = (files: FixtureFile[]) => files.map(({ binary: _binary, ...file }) => file);

    it.each(cases)("$name", ({ name, diff, files }) => {
      expect(read(() => libraryReading(diff))).toEqual(
        LIBRARY_DIFFERS[name]?.(files) ?? expected(files),
      );
    });

    it("lists only cases it still reads differently", () => {
      for (const [name, differs] of Object.entries(LIBRARY_DIFFERS)) {
        const files = cases.find((c) => c.name === name)?.files;
        expect(files && differs(files), name).not.toEqual(files && expected(files));
      }
    });
  });
});
