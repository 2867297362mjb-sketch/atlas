import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectFloor } from "./support/floor";
import { stripTsComments } from "./support/ipc";
import { isTestFile, walk } from "./support/walk";

/**
 * Only `lib/` and `stores/` talk to the backend.
 *
 * `AGENTS.md` says "never `invoke` from a component": a feature reaches Rust
 * through a typed wrapper in its `lib/<domain>-api.ts`, and a component calls
 * the wrapper. The rule is what keeps the IPC seam in a few dozen files with
 * the command name, the argument names and the payload type stated once, and
 * it is what lets a component be tested by mocking one module.
 *
 * Nothing else in the toolchain holds it. A component that imports `invoke`
 * type-checks, lints and works; so does a second one that copies it, with the
 * argument names retyped by hand, and by the time someone audits there are
 * thirty call sites and three spellings of one payload. The audit that led to
 * this suite found exactly that, in `git`, `artifacts`, `memory`, `comms` and
 * the titlebar.
 *
 * So: no file under `src/` may import `invoke`, `Channel`, `listen`, `once`,
 * `emit` or `emitTo` from `@tauri-apps/api/*`, unless it is
 *
 *   - under a `lib/` or a `stores/` directory, where the wrappers and the
 *     stores that mirror Rust's state live (`src/lib/` included);
 *   - under `src/test/` or `src/dev/` (the fake and the mock backend, which
 *     ARE the other side of the seam), or `src/bindings/` (generated);
 *   - a test file.
 *
 * The rest of `@tauri-apps/api` is not the seam and is not matched:
 * `convertFileSrc` builds a URL, `isTauri` reads a flag, `getCurrentWindow`
 * is the window's own handle. A type-only import is erased and is not matched
 * either.
 *
 * To fix a failure, move the call into the feature's `lib/<domain>-api.ts`
 * as a named, typed function (`onGitChanged`, `readCheckpoints`), creating the
 * file if the feature has none, and import that. `ALLOWED` is the exit for a
 * call that cannot move, by exact path, with the reason; it is empty.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");

/** What crosses to Rust: commands, channels and Tauri events. */
const SEAM = new Set(["invoke", "Channel", "listen", "once", "emit", "emitTo"]);

/** Directories whose files may hold the seam, anywhere in the path. */
const SEAM_DIRS = ["lib", "stores"];
/** Whole trees that are the other side of the seam, or generated from it. */
const EXEMPT_ROOTS = ["src/test/", "src/dev/", "src/bindings/"];

/**
 * Files outside `lib/` and `stores/` that may import the seam, by exact path,
 * each with why the call cannot move. Checked: a reason under 20 characters,
 * a path that is gone, or an entry that no longer imports anything fails.
 */
const ALLOWED: Record<string, string> = {};
const MIN_REASON = 20;

const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

function mayHoldSeam(where: string): boolean {
  if (EXEMPT_ROOTS.some((root) => where.startsWith(root))) return true;
  const dirs = where.split("/").slice(0, -1);
  return SEAM_DIRS.some((dir) => dirs.includes(dir));
}

const FROM_TAURI = String.raw`["']@tauri-apps/api(?:/[\w-]+)?["']`;
const NAMED_IMPORT = new RegExp(
  String.raw`\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*${FROM_TAURI}`,
  "g",
);
/** The modules that export the seam; `window`, `app`, `webview` do not. */
const SEAM_MODULE = String.raw`["']@tauri-apps/api(?:/(?:core|event))?["']`;
const WHOLE_MODULE = new RegExp(
  String.raw`\bimport\s+\*\s+as\s+[\w$]+\s+from\s*${SEAM_MODULE}|\bimport\s*\(\s*${SEAM_MODULE}\s*\)`,
);

/**
 * The seam names `source` imports from `@tauri-apps/api/*` as values. A
 * namespace or dynamic import of `core` or `event` brings all of them, and is
 * reported as `*`.
 */
export function seamImports(source: string): string[] {
  const code = stripTsComments(source);
  const found: string[] = [];
  for (const [, typeOnly, names] of code.matchAll(NAMED_IMPORT)) {
    if (typeOnly) continue;
    for (const part of names.split(",")) {
      const spec = part.trim();
      if (!spec || spec.startsWith("type ")) continue;
      const name = spec.split(/\s+as\s+/)[0].trim();
      if (SEAM.has(name)) found.push(name);
    }
  }
  if (WHOLE_MODULE.test(code)) found.push("*");
  return found;
}

const files = walk(SRC, [".ts", ".tsx"]).filter((file) => !isTestFile(file));
const importers = files
  .map((file) => ({ where: rel(file), names: seamImports(readFileSync(file, "utf8")) }))
  .filter(({ names }) => names.length > 0);

describe("invoke-from-lib contract", () => {
  it("reads the tree and finds the wrappers it is built around", () => {
    // Every wrapper imports the seam, so a matcher that stopped reading
    // imports would find none here, and no offender below either.
    expectFloor("non-test TypeScript files under src/", files.length, 1350);
    expectFloor(
      "files under lib/ and stores/ that import the seam",
      importers.filter(({ where }) => mayHoldSeam(where)).length,
      135,
    );
  });

  it("catches each form of import (the rule is not vacuous)", () => {
    expect(seamImports(`import { invoke } from "@tauri-apps/api/core";`)).toEqual(["invoke"]);
    expect(
      seamImports(`import {\n  convertFileSrc,\n  invoke,\n} from "@tauri-apps/api/core";`),
    ).toEqual(["invoke"]);
    expect(
      seamImports(`import { listen as on, type UnlistenFn } from '@tauri-apps/api/event';`),
    ).toEqual(["listen"]);
    expect(seamImports(`import { Channel, invoke } from "@tauri-apps/api/core";`)).toEqual([
      "Channel",
      "invoke",
    ]);
    expect(seamImports(`import * as core from "@tauri-apps/api/core";`)).toEqual(["*"]);
    expect(seamImports(`const { emit } = await import("@tauri-apps/api/event");`)).toEqual(["*"]);
  });

  it("leaves the rest of @tauri-apps alone", () => {
    expect(seamImports(`import { convertFileSrc, isTauri } from "@tauri-apps/api/core";`)).toEqual(
      [],
    );
    expect(seamImports(`import type { UnlistenFn } from "@tauri-apps/api/event";`)).toEqual([]);
    expect(seamImports(`import { type Channel } from "@tauri-apps/api/core";`)).toEqual([]);
    expect(seamImports(`import { getCurrentWindow } from "@tauri-apps/api/window";`)).toEqual([]);
    expect(seamImports(`import { openUrl } from "@tauri-apps/plugin-opener";`)).toEqual([]);
    expect(
      seamImports(`const { getCurrentWindow } = await import("@tauri-apps/api/window");`),
    ).toEqual([]);
    expect(seamImports(`// import { invoke } from "@tauri-apps/api/core";`)).toEqual([]);
    expect(seamImports(`import { invoke } from "@/test/tauri-fake";`)).toEqual([]);
  });

  it("knows where the seam may live", () => {
    expect(mayHoldSeam("src/features/git/lib/git-watch-api.ts")).toBe(true);
    expect(mayHoldSeam("src/features/git/stores/git-store.ts")).toBe(true);
    expect(mayHoldSeam("src/lib/clipboard-api.ts")).toBe(true);
    expect(mayHoldSeam("src/dev/mock-backend/install.ts")).toBe(true);
    expect(mayHoldSeam("src/App.tsx")).toBe(false);
    expect(mayHoldSeam("src/components/titlebar.tsx")).toBe(false);
    expect(mayHoldSeam("src/features/git/components/commit-view.tsx")).toBe(false);
    expect(mayHoldSeam("src/features/chat/hooks/use-composer-attachments.ts")).toBe(false);
    // A file NAMED like a wrapper is not one because of its name.
    expect(mayHoldSeam("src/components/code-search-api.ts")).toBe(false);
    expect(mayHoldSeam("src/features/library/components/lib-view.tsx")).toBe(false);
  });

  it("no file outside lib/ and stores/ imports the seam", () => {
    const offenders = importers
      .filter(({ where }) => !mayHoldSeam(where) && !(where in ALLOWED))
      .map(({ where, names }) => `${where}: ${names.join(", ")}`);
    expect(
      offenders,
      [
        "These import the IPC seam from @tauri-apps/api outside lib/ and stores/.",
        "Move each call into the feature's lib/<domain>-api.ts as a typed function",
        'and import that instead (AGENTS.md, "Adding things"):',
        ...offenders.map((o) => `  ${o}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("every allowlist entry is argued and still needed", () => {
    const thin = Object.entries(ALLOWED)
      .filter(([, reason]) => reason.trim().length < MIN_REASON)
      .map(([file]) => file);
    expect(thin, "an allowlist entry with no reason beside it is a suppression").toEqual([]);

    const stale = Object.keys(ALLOWED).filter(
      (file) => !importers.some(({ where }) => where === file),
    );
    expect(stale, "these no longer import the seam (or are gone): delete the entry").toEqual([]);
  });
});
