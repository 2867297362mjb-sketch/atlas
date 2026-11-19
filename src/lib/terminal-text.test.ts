import { describe, expect, it } from "vitest";
import { plainTerminalText } from "./terminal-text";

describe("plainTerminalText", () => {
  it("drops colour and cursor escapes", () => {
    expect(plainTerminalText("\x1b[32m✓\x1b[0m passed \x1b[1;31mfailed\x1b[m")).toBe(
      "✓ passed failed",
    );
    expect(plainTerminalText("\x1b]0;window title\x07done\x1b[2K\x1b[1G")).toBe("done");
  });

  it("draws a progress bar's redraws as its last state", () => {
    expect(plainTerminalText("Downloading 10%\rDownloading 55%\rDownloading 100%\ndone")).toBe(
      "Downloading 100%\ndone",
    );
    // A shorter redraw leaves the longer one's tail, as a terminal shows it.
    expect(plainTerminalText("12345\rab")).toBe("ab345");
  });

  it("treats CRLF as a line end, not an overwrite", () => {
    expect(plainTerminalText("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  it("leaves plain text alone", () => {
    expect(plainTerminalText("plain\ntext")).toBe("plain\ntext");
  });
});
