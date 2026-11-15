import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./support/walk";
import { expectFloor } from "./support/floor";
import {
  INVOKE_DYNAMIC,
  INVOKE_LITERAL,
  declaredCommands,
  registeredCommands,
  rustCommandFiles,
  stripTsComments,
} from "./support/ipc";

/**
 * Guards the Tauri IPC contract: ~350 `#[tauri::command]` handlers on the Rust
 * side against ~316 `invoke("name")` string literals on the TypeScript side.
 *
 * Nothing else in the toolchain can see this seam. `tsc --noEmit` type-checks
 * the *arguments* to `invoke` but the command name is an opaque string, so a
 * renamed Rust command, a typo, or a handler left out of `generate_handler!`
 * all compile clean and fail at runtime — as a rejected promise inside a
 * feature panel, usually reported as "the button does nothing".
 *
 * We parse source text rather than compiling anything. The alternative
 * (`tauri-specta` generated bindings) would be stronger since it also checks
 * argument and return types, but it means a build-time codegen step and a
 * checked-in generated file. This test costs milliseconds and no build.
 *
 * If you add a command, nothing here needs updating — the sets are derived.
 * The parsers themselves are in `tests/support/ipc.ts`, shared with
 * `mock-backend-contract.test.ts`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_SRC = path.join(REPO_ROOT, "src");

/**
 * Floors that make a vacuous pass impossible.
 *
 * The failure mode this defends against: someone reformats `lib.rs`, a regex
 * below stops matching, every derived set comes back empty, and the equality
 * assertions pass trivially — leaving a green test that guards nothing,
 * possibly for years. These numbers are deliberately a little under the real
 * counts; they are a smoke alarm for "the parser broke", not a coverage
 * target, so they should only ever be raised if a parser rewrite needs a
 * tighter alarm.
 */
const MIN_RUST_FILES = 170;
const MIN_TS_FILES = 1800;
const MIN_DECLARED = 500;
const MIN_REGISTERED = 500;
const MIN_INVOKED = 500;

/** Repo-relative with forward slashes whatever the OS, so paths compare
 *  against the hand-written tables below on Windows too. */
const posixRelative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/**
 * The call sites that pass `invoke` a variable, with the literal command
 * names that flow into that variable in the same file. A literal scan can't
 * follow data flow, so each site is listed by hand; the tests below check
 * that the list is complete (a new dynamic site fails until it's added
 * here), that each literal still appears in its file, and that each is
 * registered.
 */
const DYNAMIC_INVOKE_SITES: Record<string, string[]> = {
  // `runHunkOp(cmd, …)` → `invoke(cmd, …)`
  "src/features/git/components/git-manager/changes-view.tsx": [
    "git_stage_hunk",
    "git_unstage_hunk",
    "git_discard_hunk",
  ],
};

function frontendFiles(): Array<{ where: string; src: string }> {
  return walk(TS_SRC, [".ts", ".tsx"]).map((file) => ({
    where: posixRelative(file),
    src: stripTsComments(readFileSync(file, "utf8")),
  }));
}

/** Command names the frontend calls as string literals. */
function invokedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { where, src } of frontendFiles()) {
    for (const match of src.matchAll(INVOKE_LITERAL)) {
      const name = match[1];
      found.set(name, [...(found.get(name) ?? []), where]);
    }
  }
  return found;
}

/**
 * Registered commands known to have no frontend caller, kept until their own
 * owners retire them. Each entry is a known dead command, not a licence:
 * remove the entry when the command is removed, and never add one for a new
 * command.
 */
const KNOWN_UNCALLED = new Set<string>([]);

/**
 * Every command name the frontend mentions as a string literal, on any line
 * that is not a comment. Looser than `invokedCommands` on purpose: a call site
 * can span lines (`invoke<{ … }>(\n  "name",`), carry a generic `invoke` cannot
 * parse (`Record<string, T>`), or pick its name in a ternary
 * (`action === "stage" ? "git_stage_hunk" : "git_unstage_hunk"`). All of those
 * still hand the name to `invoke` as a literal, so its presence is the caller.
 */
function frontendCommandLiterals(): Set<string> {
  const found = new Set<string>();
  const literal = /["'`]([a-z][a-z0-9_]*)["'`]/g;
  for (const file of walk(TS_SRC, [".ts", ".tsx"])) {
    if (/\.test\.tsx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
      for (const match of line.matchAll(literal)) found.add(match[1]);
    }
  }
  return found;
}

/** Shipping files that pass `invoke` a non-literal first argument. Tests and
 *  the mock backend under `src/dev/` forward names generically by design. */
function dynamicInvokeFiles(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { where, src } of frontendFiles()) {
    if (where.startsWith("src/dev/") || /\.test\.tsx?$/.test(where)) continue;
    const idents = [...src.matchAll(INVOKE_DYNAMIC)].map((m) => m[1]);
    if (idents.length) found.set(where, idents);
  }
  return found;
}

describe("tauri IPC contract", () => {
  const declared = declaredCommands();
  const registered = registeredCommands();
  const invoked = invokedCommands();
  const dynamic = dynamicInvokeFiles();
  const registeredSet = new Set(registered);

  // These three run first so that a broken parser reports itself as a broken
  // parser, rather than as a confusing "0 commands differ" pass.
  it("reads a plausible number of files on both sides", () => {
    expectFloor("Rust files under src-tauri/src", rustCommandFiles().length, MIN_RUST_FILES);
    expectFloor("TypeScript files under src/", frontendFiles().length, MIN_TS_FILES);
  });

  it("parses a plausible number of declared commands", () => {
    expectFloor("#[tauri::command] handlers in src-tauri/src", declared.size, MIN_DECLARED);
  });

  it("parses a plausible number of registered commands", () => {
    expectFloor("commands in generate_handler![] in lib.rs", registered.length, MIN_REGISTERED);
  });

  it("parses a plausible number of invoked commands", () => {
    expectFloor('invoke("name") literals under src/', invoked.size, MIN_INVOKED);
  });

  it("registers every command name exactly once", () => {
    // Tauri keys the IPC router on the bare fn name, so two handlers sharing a
    // name in different modules collide however they are namespaced in Rust.
    const duplicates = registered.filter((n, i) => registered.indexOf(n) !== i);
    expect([...new Set(duplicates)]).toEqual([]);

    const collisions = [...declared.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name} declared in ${files.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("every frontend invoke() targets a registered command", () => {
    const missing = [...invoked.entries()]
      .filter(([name]) => !registeredSet.has(name))
      .map(([name, files]) => `invoke("${name}") in ${files.join(", ")}`);

    // Fails when a Rust command is renamed or deleted without updating its
    // callers, and when a call site has a typo.
    expect(missing).toEqual([]);
  });

  it("reads invoke() calls with nested generics and a name on the next line", () => {
    // Each of these is only ever called through a nested or multi-line type
    // argument; if the generic match regressed they'd silently drop out.
    for (const name of [
      "models_pricing_get",
      "capture_screenshot",
      "knowledge_export_server",
      "import_into_knowledge",
    ]) {
      expect(invoked.has(name), `invoke("${name}") not seen`).toBe(true);
    }
  });

  it("every dynamic invoke(variable) site is listed, with its literals", () => {
    // A new `invoke(cmd, …)` whose name the literal scan can't see must be
    // listed in DYNAMIC_INVOKE_SITES, or its command goes unchecked.
    expect([...dynamic.keys()].sort()).toEqual(Object.keys(DYNAMIC_INVOKE_SITES).sort());

    const problems: string[] = [];
    for (const [file, names] of Object.entries(DYNAMIC_INVOKE_SITES)) {
      const src = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const name of names) {
        if (!src.includes(`"${name}"`)) problems.push(`${name} no longer appears in ${file}`);
        if (!registeredSet.has(name)) problems.push(`${name} (${file}) is not registered`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every #[tauri::command] is registered in generate_handler!", () => {
    const unregistered = [...declared.keys()]
      .filter((name) => !registeredSet.has(name))
      .map((name) => `${name} (${declared.get(name)!.join(", ")})`);

    // An unregistered handler is dead code that looks live: the fn compiles,
    // clippy is happy, and the frontend gets "command not found" at runtime.
    expect(unregistered).toEqual([]);
  });

  it("every registered command has a frontend caller", () => {
    // A registered command nothing calls is surface with no user: it has to
    // be maintained, reviewed and kept safe, and it hides which capability
    // actually lives where. Delete the command, or wire its caller.
    const literals = frontendCommandLiterals();
    expectFloor("snake_case string literals in shipping TypeScript", literals.size, 2300);
    const uncalled = registered.filter((name) => !literals.has(name) && !KNOWN_UNCALLED.has(name));
    expect(uncalled).toEqual([]);

    // The allowlist only ever shrinks: an entry whose command gained a caller
    // or was deleted must go too.
    const stale = [...KNOWN_UNCALLED].filter(
      (name) => literals.has(name) || !registeredSet.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("registers no command that has no #[tauri::command] handler", () => {
    // The reverse drift: an entry left in `generate_handler!` after its
    // handler was deleted. This one at least fails the Rust build, so it is
    // here for a clear message rather than for detection.
    const orphaned = registered.filter((name) => !declared.has(name));
    expect(orphaned).toEqual([]);
  });
});
