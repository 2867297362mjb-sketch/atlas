import { describe, expect, it } from "vitest";
import { countChangedLines } from "./tool-files";
import { permissionDiffsOf, permissionLocationsOf } from "./permission-diff";

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join("\n") + "\n";

describe("a permission request's diff, as the card draws it", () => {
  it("is the changed lines with two unchanged ones either side", () => {
    const before = numbered(1, 10);
    const after = before.replace("line 5\n", "line five\n");
    const [diff] = permissionDiffsOf({
      contentBlocks: [{ type: "diff", path: "/r/a.txt", oldText: before, newText: after }],
    });
    expect(diff.lines.map((l) => `${l.sign}${l.text}`)).toEqual([
      " line 3",
      " line 4",
      "-line 5",
      "+line five",
      " line 6",
      " line 7",
    ]);
    expect({ added: diff.added, removed: diff.removed }).toEqual(countChangedLines(before, after));
  });

  it("says how much of a long change it left out", () => {
    const [diff] = permissionDiffsOf({
      contentBlocks: [{ type: "diff", path: "/r/big.txt", newText: numbered(1, 250) }],
    });
    expect(diff.added).toBe(250);
    expect(diff.lines).toHaveLength(200);
    expect(diff.more).toBe(50);
  });

  it("leaves out a location a diff already shows", () => {
    const toolCall = {
      contentBlocks: [{ type: "diff", path: "/r/a.ts", oldText: "a\n", newText: "b\n" }],
      locations: [{ path: "/r/a.ts", line: 1 }, { path: "/r/b.ts", line: 2.5 }, { line: 3 }],
    };
    expect(permissionLocationsOf(toolCall, permissionDiffsOf(toolCall))).toEqual(["/r/b.ts"]);
  });
});
