import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectFloor } from "./support/floor";

/**
 * Universal RC's wire fixtures live in two repositories: the server's
 * `packages/contracts/fixtures/rc-*.json` (the authority: the TypeScript
 * schemas are tested against them there) and this repo's
 * `crates/atlas-remote-control/tests/fixtures/` (tested against the Rust
 * codec in `tests/contract.rs`). Each side proves only that it agrees with its
 * own copy, and CI never has both repositories on one disk.
 *
 * So the copy is recorded. `source.json` beside the fixtures names the server
 * commit they were taken at and a sha256 of each, and
 * `scripts/sync-rc-fixtures.mjs` is the one thing that writes the fixtures and
 * that record together. Two checks follow.
 *
 * **Everywhere, CI included:** each fixture hashes to its recorded value, and
 * every `rc-*.json` in the directory is recorded. This is what fails when a
 * fixture is edited here by hand to make the Rust codec pass, or re-copied
 * without the script: either way the copy is no longer the server's file at
 * the commit it claims.
 *
 * **Only beside a server checkout** (`../server`, or `ATLAS_SERVER_DIR`): the
 * copies equal the server's files as they are now. That is the one check that
 * sees the server change underneath us, and it cannot run in CI; it is skipped
 * there, and in a git worktree, whose parent directory holds no `server`. Run
 * `node scripts/sync-rc-fixtures.mjs --check` to ask the same question on
 * demand, and without `--check` to re-copy.
 *
 * What nothing here can see: the server changing a fixture while no one with
 * both checkouts runs either. The server's own suite holds its schemas to its
 * fixtures, so that drift is a stale copy here, not a wrong one, until someone
 * syncs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(REPO_ROOT, "crates", "atlas-remote-control", "tests", "fixtures");
const SERVER = path.resolve(
  process.env.ATLAS_SERVER_DIR ?? path.join(REPO_ROOT, "..", "server"),
  "packages",
  "contracts",
  "fixtures",
);

interface Source {
  commit: string;
  sha256: Record<string, string>;
}

const source = JSON.parse(readFileSync(path.join(LOCAL, "source.json"), "utf8")) as Source;
const recorded = Object.keys(source.sha256).sort();

/**
 * Line endings aside: `.gitattributes` keeps the work tree LF, but a checkout
 * made before it, or with it overridden, holds CRLF over the same git bytes.
 */
const read = (file: string): string => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

describe("RC wire fixtures are the server's, byte for byte", () => {
  it("records every fixture in the directory, at a server commit", () => {
    const present = readdirSync(LOCAL)
      .filter((name) => /^rc-.*\.json$/.test(name))
      .sort();
    expectFloor(
      "rc-*.json fixtures in crates/atlas-remote-control/tests/fixtures",
      present.length,
      2,
    );
    expect(
      present,
      "a fixture was added or removed without `node scripts/sync-rc-fixtures.mjs`",
    ).toEqual(recorded);
    expect(source.commit, "source.json names the server commit the copy was taken at").toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("every fixture is the file that was copied", () => {
    for (const name of recorded) {
      const actual = createHash("sha256")
        .update(read(path.join(LOCAL, name)))
        .digest("hex");
      expect(
        actual,
        `${name} is not the server's file at ${source.commit.slice(0, 12)}. ` +
          "These are copies: change the fixture in the server repo, then " +
          "`node scripts/sync-rc-fixtures.mjs`.",
      ).toBe(source.sha256[name]);
    }
  });

  const serverPresent = recorded.every((name) => existsSync(path.join(SERVER, name)));

  it.skipIf(!serverPresent)("every fixture matches the server checkout beside this one", () => {
    for (const name of recorded) {
      expect(
        read(path.join(LOCAL, name)),
        `${name} differs from the server's. Re-copy: \`node scripts/sync-rc-fixtures.mjs\``,
      ).toBe(read(path.join(SERVER, name)));
    }
  });
});
