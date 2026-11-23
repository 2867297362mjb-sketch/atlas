// A permission request's title has no length limit on the wire, and agents
// send whole commands in it. The card's headline does not scroll, so a title
// that does not fit it has to move to the preview box, or the card outgrows
// the window and its options leave the screen.
import { describe, expect, it } from "vitest";
import { HEADLINE_MAX, permissionSummaryOf } from "./permission-summary";

const HEREDOC = `python3 - <<'EOF'\nimport re\nprint("patched")\nEOF`;

describe("permissionSummaryOf", () => {
  it("keeps a short one-line title as the headline, with the input as JSON", () => {
    expect(
      permissionSummaryOf({ title: "rm -rf dist", rawInput: { command: "rm -rf dist" } }),
    ).toEqual({
      title: "rm -rf dist",
      generic: false,
      preview: '{\n  "command": "rm -rf dist"\n}',
    });
  });

  it("has no preview for a short title with no input", () => {
    expect(permissionSummaryOf({ title: "ls", kind: "execute" }).preview).toBeNull();
  });

  it("moves a multi-line title to the preview, line breaks kept", () => {
    // The native agent's shape: the command is the title, and no input.
    expect(permissionSummaryOf({ title: HEREDOC, kind: "execute" })).toEqual({
      title: "a command",
      generic: true,
      preview: HEREDOC,
    });
  });

  it("moves a one-line title past the headline's length to the preview", () => {
    const long = "x".repeat(HEADLINE_MAX + 1);
    const summary = permissionSummaryOf({ title: long, kind: "execute" });
    expect(summary.title).toBe("a command");
    expect(summary.preview).toBe(long);
    expect(permissionSummaryOf({ title: "x".repeat(HEADLINE_MAX) }).generic).toBe(false);
  });

  it("shows a command once when the title repeats it", () => {
    expect(
      permissionSummaryOf({ title: HEREDOC, kind: "execute", rawInput: { command: HEREDOC } })
        .preview,
    ).toBe(HEREDOC);
  });

  it("reads the Claude adapter's backticked title as the same command", () => {
    const command = "echo `date`\necho done";
    expect(
      permissionSummaryOf({
        title: "`echo \\`date\\`\necho done`",
        kind: "execute",
        rawInput: { command },
      }).preview,
    ).toBe(command);
  });

  it("shows both when a long title and the command differ", () => {
    const title = "Clean the build output\nand every cache";
    expect(
      permissionSummaryOf({ title, kind: "execute", rawInput: { command: "rm -rf /" } }).preview,
    ).toBe(`${title}\n\nrm -rf /`);
  });

  it("never cuts a command, however long", () => {
    const command = "echo " + "a".repeat(10_000);
    expect(permissionSummaryOf({ title: command, rawInput: { command } }).preview).toBe(command);
  });

  it("names the kind", () => {
    expect(permissionSummaryOf({ title: HEREDOC, kind: "edit" }).title).toBe("a file edit");
    expect(permissionSummaryOf({ title: HEREDOC, kind: "fetch" }).title).toBe("a tool call");
    expect(permissionSummaryOf({ title: HEREDOC }).title).toBe("a tool call");
  });
});
