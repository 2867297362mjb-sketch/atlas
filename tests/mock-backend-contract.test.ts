// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./support/walk";

import { baseFixtureMaps, baseHandlers } from "@/dev/mock-backend/scenarios/base";
import { scenarios } from "@/dev/mock-backend/scenarios";
import { expectFloor } from "./support/floor";
import {
  DYNAMIC_INVOKE_SITES,
  INVOKE_LITERAL,
  declaredCommands,
  registeredCommands,
  stripTsComments,
} from "./support/ipc";

/**
 * Guards the dev-only browser mock backend (`src/dev/mock-backend/`) against
 * the Rust it stands in for.
 *
 * `tests/ipc-contract.test.ts` already checks that every `invoke("name")` in
 * the app names a real command. The mock is the third side of that triangle
 * and nothing was watching it: its answers are keyed by command name in a
 * plain object, so a command Rust renamed or deleted leaves a fake behind that
 * is never called again. Nothing fails — the fixture just stops being reached,
 * and the screen it was there to populate quietly goes back to empty. That is
 * the exact failure the mock exists to prevent, so it should not be the mock's
 * own failure mode.
 *
 * What this does NOT check is the shape of an answer. The fixtures are typed
 * with the frontend's own API types, so `bun run typecheck` catches a fixture
 * that drifts from the TypeScript — but those types are hand-written mirrors
 * of the Rust structs, not generated from them, so Rust can change its
 * serialisation and both TypeScript sides stay wrong together. Closing that
 * hop means generated bindings (`ts-rs` / `tauri-specta`) and is deliberately
 * not attempted here; see the note in `ipc-contract.test.ts` on the same
 * trade-off.
 *
 * Imports the handler maps rather than parsing them, so a fixture that builds
 * its keys any way it likes is still counted.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Commands deliberately answered by more than one base fixture map (or by a
 * map and an inline entry in `base.ts`), each with the reason. Object spread
 * makes the LAST definition win silently, so any other overlap is a fake that
 * reads as live and is never reached — which is how `misc`'s phantom
 * `agents_list_running` came to outrank `fake-agent`'s. Keep this short.
 */
const ALLOWED_OVERLAPS: Record<string, string> = {};

/**
 * A vacuous pass is the thing to fear: if the imports below ever resolve to an
 * empty object, every assertion here passes while guarding nothing. Well under
 * the real count — a smoke alarm, not a target.
 */
const MIN_MOCKED = 500;

const TS_SRC = path.join(REPO_ROOT, "src");

/**
 * The reverse direction: commands the app really `invoke`s that the mock does
 * not answer. An unmocked command resolves `null`, so the panel behind it
 * renders empty or throws on `null.foo`, and the only symptom is a screen that
 * looks unfinished in `bun run dev`. Each entry names the reason a fake is
 * pointless or impossible; "not done yet" is not one, fix those instead.
 * Keep this list short and only ever delete from it.
 */
const UNMOCKED_ALLOWED: Record<string, string> = {};

/**
 * Commands Tauri routes itself, which have no `#[tauri::command]` anywhere in
 * `src-tauri/src`. The mock answers them because the plugins are not loaded in
 * a plain browser.
 */
const PLUGIN_PREFIX = "plugin:";

/** Commands the shipping frontend invokes. `src/dev/` forwards names
 *  generically and is the mock itself, so it is not a caller. */
function invokedCommands(): Set<string> {
  // A name handed to `invoke` in a variable is one the literal scan cannot
  // read; those sites are listed by hand, and still need a fake.
  const found = new Set<string>(Object.values(DYNAMIC_INVOKE_SITES).flat());
  const devRoot = path.join(TS_SRC, "dev") + path.sep;
  for (const file of walk(TS_SRC, [".ts", ".tsx"])) {
    if (file.startsWith(devRoot) || /\.test\.tsx?$/.test(file)) continue;
    const src = stripTsComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(INVOKE_LITERAL)) found.add(match[1]);
  }
  return found;
}

/**
 * Which base sources define each command: every fixture map that has the key,
 * plus `base.ts (inline)` when the winning value is none of those maps' — i.e.
 * an entry written directly in the `baseHandlers` literal.
 */
function baseOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [name, handler] of Object.entries(baseHandlers)) {
    const from = Object.entries(baseFixtureMaps)
      .filter(([, map]) => Object.prototype.hasOwnProperty.call(map, name))
      .map(([source]) => source);
    const fromMap = Object.values(baseFixtureMaps).some((map) => map[name] === handler);
    owners.set(name, fromMap ? from : [...from, "base.ts (inline)"]);
  }
  return owners;
}

/** Every command name the mock answers, base plus every scenario's overrides. */
function mockedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string, where: string) => found.set(name, [...(found.get(name) ?? []), where]);

  for (const name of Object.keys(baseHandlers)) add(name, "scenarios/base.ts");
  for (const scenario of Object.values(scenarios)) {
    for (const name of Object.keys({ ...scenario.rawCommands, ...scenario.commands })) {
      add(name, `scenario "${scenario.name}"`);
    }
  }
  return found;
}

describe("browser mock backend contract", () => {
  const declared = declaredCommands();
  const registered = new Set(registeredCommands());
  const mocked = mockedCommands();

  // First, so a broken import reports itself as a broken import rather than as
  // a confusing "0 commands differ" pass.
  it("loads a plausible number of mocked commands", () => {
    expectFloor("#[tauri::command] handlers in src-tauri/src", declared.size, 500);
    expectFloor("commands in generate_handler![] in lib.rs", registered.size, 500);
    expectFloor("commands the mock backend answers", mocked.size, MIN_MOCKED);
    expectFloor("base fixture maps", Object.keys(baseFixtureMaps).length, 20);
  });

  it("answers no command that Rust does not declare", () => {
    const orphaned = [...mocked.entries()]
      .filter(([name]) => !name.startsWith(PLUGIN_PREFIX) && !declared.has(name))
      .map(([name, where]) => `${name} (faked in ${[...new Set(where)].join(", ")})`);

    // A fake with no command behind it is dead weight that reads as coverage:
    // the badge counts it as answered, so the surface it belonged to looks
    // checked when the real app can no longer reach it at all.
    expect(orphaned).toEqual([]);
  });

  it("answers no command that Rust declares but does not register", () => {
    const unregistered = [...mocked.entries()]
      .filter(([name]) => !name.startsWith(PLUGIN_PREFIX) && declared.has(name))
      .filter(([name]) => !registered.has(name))
      .map(([name, where]) => `${name} (faked in ${[...new Set(where)].join(", ")})`);

    // The real app rejects these with "command not found"; the browser mock
    // answering them hides exactly that.
    expect(unregistered).toEqual([]);
  });

  it("no two base fixtures answer the same command unless allowed", () => {
    const overlaps = [...baseOwners().entries()]
      .filter(([name, from]) => from.length > 1 && !(name in ALLOWED_OVERLAPS))
      .map(([name, from]) => `${name} (defined in ${from.join(", ")})`);

    // Every extra definition but the last is dead: nothing ever reaches it.
    expect(overlaps).toEqual([]);

    const stale = Object.keys(ALLOWED_OVERLAPS).filter(
      (name) => (baseOwners().get(name)?.length ?? 0) < 2,
    );
    expect(stale, "ALLOWED_OVERLAPS entries that no longer overlap").toEqual([]);
  });

  it("the catch-all never wins a command a domain fixture also answers", () => {
    // `base.ts` promises that `misc` is outranked by every domain file; object
    // spread only keeps that promise if misc is spread first.
    const misc = baseFixtureMaps["fixtures/misc"];
    const winsWrongly = Object.keys(misc).filter(
      (name) => (baseOwners().get(name)?.length ?? 0) > 1 && baseHandlers[name] === misc[name],
    );
    expect(winsWrongly).toEqual([]);
  });

  it("answers every command the app invokes, or says why not", () => {
    const invoked = invokedCommands();
    expectFloor("commands the shipping frontend invokes", invoked.size, 500);

    const missing = [...invoked]
      .filter((name) => !mocked.has(name) && !(name in UNMOCKED_ALLOWED))
      .sort();
    expect(
      missing,
      "These commands resolve null in `bun run dev`. Add a fake (see the README) or an UNMOCKED_ALLOWED entry with a reason.",
    ).toEqual([]);

    const stale = Object.keys(UNMOCKED_ALLOWED).filter(
      (name) => mocked.has(name) || !invoked.has(name),
    );
    expect(stale, "UNMOCKED_ALLOWED entries that are now mocked or no longer invoked").toEqual([]);
  });
});
