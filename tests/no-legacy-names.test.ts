import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectFloor } from "./support/floor";

/**
 * The retired SDK name stays retired (ADR-0011).
 *
 * The native agent was once named after an experimental SDK. Nothing
 * legitimate spells it any more, so it is banned in every tracked file, in any
 * case, except the one migration that deletes rows recorded under it and the
 * historical record (the ADRs).
 *
 * The other name ADR-0011 retired, the upstream product the engine was forked
 * from, is deliberately not scanned. It is also the name of a different
 * product Atlas runs as a third-party ACP agent (OpenAI's Codex CLI), so a
 * word ban only ever produced false positives and a long hand-kept allowlist.
 * What is structural is guarded where it lives: the engine's crates and
 * manifests by `engine-quarantine.test.ts`, its licence and notice by
 * `vendor-licensing.test.ts`, and the old vendor path below.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_SDK = /cersei/i;

/** Files the retired SDK name may still appear in, each with its reason. */
const ALLOWED_FILES: [pattern: RegExp, reason: string][] = [
  [
    /^crates\/atlas-thread-metadata\/src\/schema\.rs$/,
    "the V3 migration deletes the rows recorded under the retired id",
  ],
  [/^docs\/adr\//, "decision records are history"],
  [/^tests\/no-legacy-names\.test\.ts$/, "this file"],
  [
    /^scripts\/one-off\/rename-engine\.py$/,
    "the one-off sweep script; delete it once the rename has landed",
  ],
];

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

/** Text of a tracked file, or null when it is binary or unreadable. */
function readText(rel: string): string | null {
  try {
    const buf = readFileSync(path.join(REPO_ROOT, rel));
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}

describe("the retired names stay out of the tree", () => {
  it("the engine no longer lives under its upstream name", () => {
    expect(existsSync(path.join(REPO_ROOT, "vendor", "codex"))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, "vendor", "atlas-engine", "NOTICE"))).toBe(true);
  });

  it("nothing spells the retired SDK name", { timeout: 60_000 }, () => {
    const files = tracked();
    // `git ls-files` answering nothing (a moved root, a broken checkout) would
    // leave the scan with nothing to flag.
    expectFloor("files git tracks", files.length, 7000);

    const offenders: string[] = [];
    for (const rel of files) {
      if (ALLOWED_FILES.some(([p]) => p.test(rel))) continue;
      const text = readText(rel);
      if (text === null || !RETIRED_SDK.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (RETIRED_SDK.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `retired SDK name found:\n${offenders.slice(0, 80).join("\n")}`).toEqual([]);
  });
});
