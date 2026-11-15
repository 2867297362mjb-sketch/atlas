import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Every file under `dir` whose name ends in one of `extensions`, as absolute
 * paths. Skips `node_modules` and cargo's `target`, which no contract suite
 * means to read and which are large enough to matter.
 *
 * Shared so a new suite imports it. The older suites each carry their own
 * copy, some with different skips; moving them here is a change to make one
 * suite at a time, checking that its file count holds.
 */
export function walk(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** True for a vitest/Playwright test file. */
export function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`);
}
