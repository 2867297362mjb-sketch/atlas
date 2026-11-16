/**
 * Reading one declaration out of a source file, for the suites that check
 * Rust or TypeScript as text.
 *
 * The shapes these replace all sliced from one text anchor to another:
 * `src.indexOf("\n}\n", start)`, "everything up to the next `fn`", the first
 * `]` after a `const`. Each holds only while the formatter keeps laying the
 * file out the same way, and each fails quietly: `indexOf` answers -1, the
 * slice comes back empty or runs to the wrong place, and a check for something
 * absent from that text passes. Brackets are balanced whatever the layout, and
 * a declaration that is gone throws here instead.
 */

export type Lang = "ts" | "rust";

const CLOSER: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/**
 * The index after the string or comment that starts at `i`, or `i` itself when
 * neither starts there. Rust's `'` is a lifetime as often as a char literal,
 * so only `"` opens a string there.
 */
function skipProse(src: string, i: number, lang: Lang): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const end = src.indexOf("\n", i);
    return end === -1 ? src.length : end;
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === '"' || (lang === "ts" && (c === "'" || c === "`"))) {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

/**
 * The text between the first `open` bracket after `anchor` and the bracket
 * that closes it, brackets excluded. Brackets inside strings and comments are
 * not counted.
 *
 * `anchor` is the declaration's own words, matched once from the top of the
 * file. Prefer a pattern that ends on a word boundary (`/\bpub enum Role\b/`):
 * the plain string `"pub enum Role"` also matches `pub enum RoleKind`, and
 * would read the wrong declaration without a word. `open` may
 * list more than one bracket, for a declaration that is an array in one file
 * and an object in another; the first to appear wins.
 *
 * Throws when the anchor is missing or the bracket never closes, naming
 * `where`, so a renamed declaration fails as itself.
 */
export function bracketBody(
  src: string,
  anchor: string | RegExp,
  options: { open?: string; lang: Lang; where: string },
): string {
  const { open = "{", lang, where } = options;
  const match = typeof anchor === "string" ? src.indexOf(anchor) : src.search(anchor);
  if (match === -1) throw new Error(`${where}: no \`${String(anchor)}\` to read`);

  let start = -1;
  for (let i = match; i < src.length; i++) {
    const past = skipProse(src, i, lang);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (open.includes(src[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`${where}: no \`${open}\` after \`${String(anchor)}\``);
  }

  const opener = src[start];
  const closer = CLOSER[opener];
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const past = skipProse(src, i, lang);
    if (past !== i) {
      i = past - 1;
      continue;
    }
    if (src[i] === opener) depth++;
    else if (src[i] === closer && --depth === 0) return src.slice(start + 1, i);
  }
  throw new Error(`${where}: the \`${opener}\` after \`${String(anchor)}\` never closes`);
}
