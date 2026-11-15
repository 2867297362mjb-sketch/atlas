import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, walk } from "./support/walk";
import { expectFloor } from "./support/floor";

/**
 * Guards the *window event* seam: the DOM `CustomEvent`s on `window` that
 * features use to reach each other without importing each other. It is the
 * TS-to-TS half of the `atlas:` namespace; `event-contract.test.ts` guards the
 * other half, the Tauri channels, and leaves this one out on purpose.
 *
 * `src/lib/window-events.ts` declares every window event and its payload in
 * one map, and three helpers (`emitWindowEvent`, `onWindowEvent`,
 * `useWindowEvent`) typed by it, so `tsc` checks a name and its payload at
 * every call that goes through them. What `tsc` cannot do is make a call go
 * through them: `window.dispatchEvent(new CustomEvent("atlas:chat-send", …))`
 * and `window.addEventListener("atlas:chat-send", …)` compile exactly as
 * well, with the name an opaque string and the payload cast by hand at the
 * other end. One such site and the map is no longer the answer to "who emits
 * this, who hears it, and what does it carry". Nothing fails when that
 * happens: a typo in the name is a listener that waits forever, and a payload
 * field renamed at the emitter is `undefined` at the listener.
 *
 * Four things, none of which a compiler or a linter sees:
 *
 *   1. **The names live in the map.** A window event's name appears as a
 *      string literal in `src/` only as the first argument of one of the
 *      three helpers, where `tsc` checks it. Not in an exported constant, not
 *      in an array of names, not in an `addEventListener`. (Prose is free:
 *      a name in a comment or a test title is not a `"…"` literal on its own.)
 *
 *   2. **Nothing reaches around the helpers.** No file constructs a
 *      `CustomEvent`, or a DOM `Event` named `atlas:…`, and none adds or
 *      removes a listener for an `atlas:…` name directly. This is what
 *      catches an event that is not in the map at all, which rule 1 cannot
 *      know the name of.
 *
 *   3. **Every event has both ends.** Each name in the map has at least one
 *      emitter and at least one listener in shipping code. An event with one
 *      end missing is dead code that still looks wired; the ones known today
 *      are listed in `KNOWN_ONE_ENDED` with what is missing, and the list
 *      fails when an entry stops being true.
 *
 *   4. **The two namespaces do not overlap.** No window event has the name of
 *      a Tauri channel (a Rust `"atlas:…"` literal, or a channel a TS file
 *      passes to `listen`/`once`/`emit`). They share the prefix, so a
 *      collision would have one `emit` reach listeners written for the other.
 *
 * Two places speak the DOM directly and are meant to. `index.html` listens
 * for `atlas:app-ready` in an inline script, because it runs before any
 * module does; that listener counts as the event's listener, and must name an
 * event in the map. And the helpers' own unit test proves they interoperate
 * with native listeners, so it is exempt from rules 1 and 2, with the map
 * file itself.
 *
 * Adding an event needs nothing here: the sets are derived from the map.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_SRC = path.join(REPO_ROOT, "src");
const MAP_FILE = path.join(TS_SRC, "lib", "window-events.ts");
const INDEX_HTML = path.join(REPO_ROOT, "index.html");
const RUST_ROOTS = [path.join(REPO_ROOT, "src-tauri", "src"), path.join(REPO_ROOT, "crates")];

/** The map, and the helpers' unit test: the two files allowed to speak the
 *  DOM directly. */
const EXEMPT = new Set([MAP_FILE, path.join(TS_SRC, "lib", "window-events.test.tsx")]);

/**
 * Events with one end missing today, and which. Found when the map was
 * written; each is a listener nobody has emitted to since some refactor.
 * Remove the entry when the event gets its other end or is deleted: the suite
 * fails on an entry that is no longer true.
 */
const KNOWN_ONE_ENDED: Record<string, "no emitter" | "no listener"> = {
  // The composer still quotes a message on this; no "Reply" button fires it.
  "atlas:chat-reply": "no emitter",
  // `App` still opens the ⌘T palette on this; the hotkey calls it directly.
  "atlas:new-tab-palette": "no emitter",
};

/**
 * Floors that make a vacuous pass impossible: if a refactor moves the map or
 * breaks a regex, the derived sets collapse and every assertion below passes
 * by matching nothing. A little under the real counts: an alarm for "the scan
 * broke", not a target.
 */
const MIN_EVENTS = 30;
const MIN_FILES = 1800;
const MIN_EMIT_SITES = 75;
const MIN_LISTEN_SITES = 68;
const MIN_CHANNELS = 52;

const rel = (file: string) => path.relative(REPO_ROOT, file);

/** The names declared in `AtlasWindowEvents`. */
function declaredEvents(): string[] {
  const src = readFileSync(MAP_FILE, "utf8");
  const start = src.indexOf("export interface AtlasWindowEvents {");
  if (start < 0) return [];
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s+"(atlas:[a-z0-9:-]+)"\s*:/gm)].map((m) => m[1]);
}

const HELPER_CALL = /\b(emitWindowEvent|onWindowEvent|useWindowEvent)\s*\(\s*$/;

interface Site {
  file: string;
  line: number;
  name: string;
  /** The helper the literal is the first argument of, or null for a bare one. */
  helper: "emitWindowEvent" | "onWindowEvent" | "useWindowEvent" | null;
}

/** Every `"atlas:…"` literal in `src`, with the helper call it sits in. */
function literalSites(src: string, file: string): Site[] {
  const out: Site[] = [];
  for (const m of src.matchAll(/"(atlas:[a-z0-9:_-]+)"/g)) {
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    const helper = before.match(HELPER_CALL)?.[1] as Site["helper"] | undefined;
    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      name: m[1],
      helper: helper ?? null,
    });
  }
  return out;
}

/** Ways to reach a window event around the helpers. */
const DIRECT: Array<[RegExp, string]> = [
  [/\bnew\s+CustomEvent\b/g, "constructs a CustomEvent"],
  [/\bnew\s+Event\s*\(\s*["'`]atlas:/g, "constructs an `atlas:` Event"],
  [/\b(?:add|remove)EventListener\s*\(\s*["'`]atlas:/g, "adds or removes an `atlas:` listener"],
];

function directSites(src: string): Array<{ line: number; what: string }> {
  const out: Array<{ line: number; what: string }> = [];
  for (const [pattern, what] of DIRECT) {
    for (const m of src.matchAll(pattern)) {
      out.push({ line: src.slice(0, m.index).split("\n").length, what });
    }
  }
  return out;
}

/** Tauri channel names: every Rust `"atlas:…"` literal, and every channel a
 *  TS file hands to `listen`/`once`/`emit` (the mock backend's included: a
 *  name it emits under is a channel name). */
function tauriChannels(tsFiles: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const root of RUST_ROOTS) {
    for (const file of walk(root, [".rs"])) {
      for (const m of readFileSync(file, "utf8").matchAll(/"(atlas:[a-z0-9:_-]+)"/g)) {
        // `atlas::module` is a Rust log target, not a channel.
        if (!m[1].startsWith("atlas::")) out.add(m[1]);
      }
    }
  }
  const call = /\b(?:listen|once|emit|emitTo)\s*(?:<[^;]*?>)?\s*\(\s*"(atlas:[a-z0-9:_-]+)"/g;
  for (const src of tsFiles.values()) {
    for (const m of src.matchAll(call)) out.add(m[1]);
  }
  return out;
}

describe("window event contract", () => {
  const events = declaredEvents();
  const declared = new Set(events);
  const files = new Map(
    walk(TS_SRC, [".ts", ".tsx"]).map((file) => [file, readFileSync(file, "utf8")] as const),
  );
  const sites = [...files].flatMap(([file, src]) =>
    EXEMPT.has(file) ? [] : literalSites(src, file),
  );
  const windowSites = sites.filter((s) => declared.has(s.name));
  const shipping = windowSites.filter((s) => !isTestFile(s.file));
  // The mock backend and the design gallery are dev tooling: they may listen,
  // but an emit from them is not what makes an event live in the app.
  const DEV_DIR = path.join(TS_SRC, "dev") + path.sep;
  const emitted = new Set(
    shipping
      .filter((s) => s.helper === "emitWindowEvent" && !s.file.startsWith(DEV_DIR))
      .map((s) => s.name),
  );
  const heard = new Set(
    shipping
      .filter((s) => s.helper === "onWindowEvent" || s.helper === "useWindowEvent")
      .filter((s) => !s.file.startsWith(DEV_DIR))
      .map((s) => s.name),
  );
  const indexHtml = readFileSync(INDEX_HTML, "utf8");
  const htmlListeners = [...indexHtml.matchAll(/addEventListener\(\s*"(atlas:[a-z0-9:-]+)"/g)].map(
    (m) => m[1],
  );
  for (const name of htmlListeners) heard.add(name);
  const channels = tauriChannels(files);

  it("scanned enough to be meaningful", () => {
    expectFloor("events declared in AtlasWindowEvents", events.length, MIN_EVENTS);
    expect(new Set(events).size).toBe(events.length);
    expectFloor("TypeScript files under src/", files.size, MIN_FILES);
    expectFloor(
      "emitWindowEvent call sites",
      windowSites.filter((s) => s.helper === "emitWindowEvent").length,
      MIN_EMIT_SITES,
    );
    expectFloor(
      "onWindowEvent and useWindowEvent call sites",
      windowSites.filter((s) => s.helper === "onWindowEvent" || s.helper === "useWindowEvent")
        .length,
      MIN_LISTEN_SITES,
    );
    expectFloor("Tauri channels named in Rust", channels.size, MIN_CHANNELS);
    // `index.html`'s boot-skeleton listener is the one native listener there
    // is; if it stops matching, rule 3 loses the listener it counts on.
    expect(htmlListeners).toContain("atlas:app-ready");
  });

  it("the scanners see what they are for", () => {
    const sample = [
      'emitWindowEvent("atlas:chat-send", { text });',
      "onWindowEvent(",
      '  "atlas:chat-stop",',
      "  () => {},",
      ");",
      'useWindowEvent("atlas:chat-focus", () => {});',
      'export const CHAT_SEND = "atlas:chat-send";',
      'const names = ["atlas:chat-focus"];',
      'listen("atlas:git-changed", () => {});',
      "// `atlas:chat-send` in prose is not a literal",
      'it("sends an atlas:chat-send", () => {});',
    ].join("\n");
    const found = literalSites(sample, "sample.ts").map((s) => [s.line, s.name, s.helper]);
    expect(found).toEqual([
      [1, "atlas:chat-send", "emitWindowEvent"],
      [3, "atlas:chat-stop", "onWindowEvent"],
      [6, "atlas:chat-focus", "useWindowEvent"],
      [7, "atlas:chat-send", null],
      [8, "atlas:chat-focus", null],
      [9, "atlas:git-changed", null],
    ]);

    const direct = [
      'window.dispatchEvent(new CustomEvent("atlas:x", { detail }));',
      "window.dispatchEvent(new CustomEvent(NAME));",
      'window.dispatchEvent(new Event("atlas:x"));',
      'window.addEventListener("atlas:x", fn);',
      "window.removeEventListener(",
      '  "atlas:x",',
      "  fn,",
      ");",
      'window.addEventListener("keydown", fn);',
      'document.dispatchEvent(new Event("selectionchange"));',
    ].join("\n");
    expect(
      directSites(direct)
        .map((d) => d.line)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("a window event's name is a literal only as a helper's first argument", () => {
    const bare = windowSites
      .filter((s) => s.helper === null)
      .map((s) => `${rel(s.file)}:${s.line}  "${s.name}"`);
    expect(
      bare,
      "A window event name outside a helper call. Pass the literal straight to " +
        "emitWindowEvent / onWindowEvent / useWindowEvent (src/lib/window-events.ts) " +
        "instead of holding it in a constant or a list:\n" +
        bare.join("\n"),
    ).toEqual([]);
  });

  it("the helpers are only ever handed names from the map", () => {
    // `tsc` already refuses these; this catches one silenced with a cast or a
    // `@ts-expect-error` outside the type-level test.
    const TYPE_TEST = path.join(TS_SRC, "lib", "window-events.types.test.ts");
    const unknown = sites
      .filter((s) => s.helper !== null && !declared.has(s.name) && s.file !== TYPE_TEST)
      .map((s) => `${rel(s.file)}:${s.line}  ${s.helper}("${s.name}")`);
    expect(unknown).toEqual([]);
  });

  it("nothing dispatches or listens for an atlas: event around the helpers", () => {
    const offenders: string[] = [];
    for (const [file, src] of files) {
      if (EXEMPT.has(file)) continue;
      for (const d of directSites(src)) offenders.push(`${rel(file)}:${d.line}  ${d.what}`);
    }
    expect(
      offenders,
      "Window events go through emitWindowEvent / onWindowEvent / useWindowEvent " +
        "(src/lib/window-events.ts); declare the event in AtlasWindowEvents first:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("index.html listens only for events in the map", () => {
    expect(htmlListeners.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("every event has an emitter and a listener in shipping code", () => {
    const oneEnded: Record<string, string> = {};
    for (const name of events) {
      if (!emitted.has(name)) oneEnded[name] = "no emitter";
      else if (!heard.has(name)) oneEnded[name] = "no listener";
    }
    // Exact, both ways: a new one-ended event fails, and so does an entry in
    // KNOWN_ONE_ENDED that has since been wired up or removed.
    expect(oneEnded).toEqual(KNOWN_ONE_ENDED);
    // Neither end at all is not "known", it is a map entry to delete.
    const orphans = events.filter((name) => !emitted.has(name) && !heard.has(name));
    expect(orphans).toEqual([]);
  });

  it("no window event shares its name with a Tauri channel", () => {
    const collisions = events.filter((name) => channels.has(name));
    expect(
      collisions,
      "These names are both a window event (src/lib/window-events.ts) and a " +
        "Tauri channel (a Rust literal, or a TS listen/once/emit). Rename the " +
        "window event:\n" +
        collisions.join("\n"),
    ).toEqual([]);
  });
});
