import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Directory names no contract suite means to read: cargo's `target` holds
 * vendored dependency sources (every `#[tauri::command]` in every crate Atlas
 * depends on), and both are large enough to matter.
 */
export const DEFAULT_SKIP: readonly string[] = ["target", "node_modules"];

export interface WalkOptions {
  /** Directory names not descended into, at any depth. Replaces `DEFAULT_SKIP`. */
  skip?: readonly string[];
}

function collect(
  dir: string,
  keep: (name: string) => boolean,
  skip: readonly string[],
  out: string[],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) collect(full, keep, skip, out);
    } else if (keep(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every file under `dir` whose name ends in one of `extensions`, as absolute
 * paths, in directory order. A `dir` that does not exist throws: a suite whose
 * root moved should say so, not scan nothing.
 *
 * The one walker for every suite in `tests/`. What a suite leaves out beyond
 * the skipped directories (test files, the mock backend, one file by name) is
 * a `.filter()` at its call site, where the reason can sit beside it.
 */
export function walk(
  dir: string,
  extensions: readonly string[],
  options: WalkOptions = {},
): string[] {
  return collect(
    dir,
    (name) => extensions.some((e) => name.endsWith(e)),
    options.skip ?? DEFAULT_SKIP,
    [],
  );
}

/** Every file under `dir`, whatever its name. Same order and skips as `walk`. */
export function walkAll(dir: string, options: WalkOptions = {}): string[] {
  return collect(dir, () => true, options.skip ?? DEFAULT_SKIP, []);
}

/** True for a vitest/Playwright test file. */
export function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`);
}
