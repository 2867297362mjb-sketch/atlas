#!/usr/bin/env node
/**
 * Re-copy the RC wire fixtures from the server checkout, and record what was
 * copied.
 *
 *   node scripts/sync-rc-fixtures.mjs            copy, and rewrite source.json
 *   node scripts/sync-rc-fixtures.mjs --check    report drift, change nothing
 *
 * The server's `packages/contracts/fixtures/rc-*.json` are the authority; the
 * copies in `crates/atlas-remote-control/tests/fixtures/` are what the Rust
 * codec is tested against. `source.json` beside them records the server commit
 * they were taken at and a sha256 of each, and `tests/rc-fixture-parity.test.ts`
 * holds the copies to those hashes on every machine. This script is the only
 * thing that should write either.
 *
 * The server checkout is `../server`, or `ATLAS_SERVER_DIR`. `--check` exits 1
 * on drift, and 2 when there is no server checkout to compare against.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(REPO_ROOT, "crates", "atlas-remote-control", "tests", "fixtures");
const MANIFEST = path.join(LOCAL, "source.json");
const SERVER_ROOT = process.env.ATLAS_SERVER_DIR
  ? path.resolve(process.env.ATLAS_SERVER_DIR)
  : path.resolve(REPO_ROOT, "..", "server");
const SERVER_PATH = "packages/contracts/fixtures";
const SERVER = path.join(SERVER_ROOT, SERVER_PATH);

const check = process.argv.includes("--check");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const names = Object.keys(manifest.sha256);

/** LF always: git holds LF, and a Windows work tree may not. */
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

if (!names.every((name) => existsSync(path.join(SERVER, name)))) {
  console.error(
    `No server fixtures at ${SERVER}. Check out the server repo beside this one, ` +
      "or point ATLAS_SERVER_DIR at it.",
  );
  process.exit(2);
}

/** The last server commit to touch any of the fixtures, in its work tree's history. */
const commit = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", ...names.map((name) => `${SERVER_PATH}/${name}`)],
  { cwd: SERVER_ROOT, encoding: "utf8" },
).trim();

const drifted = names.filter(
  (name) => read(path.join(SERVER, name)) !== read(path.join(LOCAL, name)),
);

if (check) {
  if (drifted.length === 0) {
    console.log(`RC fixtures match the server's (${commit.slice(0, 12)}).`);
    process.exit(0);
  }
  console.error(
    `RC fixtures have drifted from the server's (${commit.slice(0, 12)}; ` +
      `recorded ${String(manifest.commit).slice(0, 12)}):`,
  );
  for (const name of drifted) console.error(`  ${name}`);
  console.error("Re-copy with: node scripts/sync-rc-fixtures.mjs");
  process.exit(1);
}

const next = { ...manifest, commit, sha256: {} };
for (const name of names) {
  const text = read(path.join(SERVER, name));
  writeFileSync(path.join(LOCAL, name), text);
  next.sha256[name] = sha256(text);
}
writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
console.log(
  drifted.length === 0
    ? `RC fixtures already match the server's (${commit.slice(0, 12)}).`
    : `Re-copied ${drifted.join(", ")} from the server (${commit.slice(0, 12)}). ` +
        "Run `cargo test -p atlas-remote-control --test contract` before committing.",
);
