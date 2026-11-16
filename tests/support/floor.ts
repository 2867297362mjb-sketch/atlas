import { expect } from "vitest";

/**
 * A floor under something a suite counted: files it scanned, or the commands,
 * channels, sites or keys it extracted from them.
 *
 * Most contract suites read source as text and assert that a scan found no
 * violation. That assertion is also true of a scan that read nothing: move a
 * directory, or let a pattern stop matching, and the suite stays green while
 * guarding nothing, with no one told. The floor is what fails instead, and its
 * message says which count fell and what to look at.
 *
 * `floor` is a smoke alarm, not a target. Set it a little under the real count
 * and leave it: counts drift every week and a floor equal to today's number
 * fails on an ordinary deletion. Lower one only when the tree truly shrank.
 * To see the real counts beside their floors:
 * `ATLAS_FLOOR_REPORT=1 bun run test:contracts --silent=false`.
 *
 * `what` names the thing counted, with where it was looked for:
 * `"TypeScript files under src/"`, `"#[tauri::command] handlers in src-tauri/src"`.
 */
export function expectFloor(what: string, found: number, floor: number): void {
  if (process.env.ATLAS_FLOOR_REPORT) console.log(`floor\t${found}\t${floor}\t${what}`);
  expect(
    found,
    `${what}: found ${found}, expected at least ${floor}. ` +
      "This scan is reading the wrong place or its pattern stopped matching, " +
      "so every check built on it would pass by finding nothing. Fix the path " +
      "or the pattern; lower the floor only if the tree really shrank.",
  ).toBeGreaterThanOrEqual(floor);
}
