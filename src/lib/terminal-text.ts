/**
 * A command's output as a reader sees it in a terminal, for showing it
 * outside one.
 *
 * Commands an agent runs in a PTY (`terminal/create`) print colour and cursor
 * escapes, and progress bars redraw a line with `\r`. Shown verbatim they read
 * as `[32m✓[0m`, with every redraw of a progress bar stacked on one line.
 * This drops the escapes and applies the carriage returns. Display only: the
 * agent is always given the bytes as they were.
 */

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and the
// two-byte escapes (`ESC c`, `ESC =`, …). Built from code points rather than
// written as a literal: the control bytes are the point here.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ESCAPES = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
);

/** `text` without terminal escapes, with each `\r` overwriting its line from
 *  the start the way a terminal draws it. */
export function plainTerminalText(text: string): string {
  if (!text.includes("\x1b") && !text.includes("\r")) return text;
  const bare = text.replace(ESCAPES, "");
  return bare
    .split("\n")
    .map((line) => {
      // "\r\n" ends a line; it does not overwrite it.
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!body.includes("\r")) return body;
      let drawn = "";
      for (const pass of body.split("\r")) {
        drawn = pass + drawn.slice(pass.length);
      }
      return drawn;
    })
    .join("\n");
}
