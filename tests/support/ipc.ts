import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bracketBody } from "./source";
import { walk } from "./walk";

/**
 * The Tauri command seam, read from source: what Rust declares, what it
 * registers, and how the frontend names a command.
 *
 * `ipc-contract` checks the three against each other and `mock-backend-contract`
 * checks the browser mock against the same three. Each used to carry its own
 * copy of these parsers, "kept in step by hand"; a fix to one (stacked
 * attributes, nested generics) then held in one suite and not the other.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RUST_SRC = path.join(REPO_ROOT, "src-tauri", "src");
const LIB_RS = path.join(RUST_SRC, "lib.rs");

/** Repo-relative with forward slashes whatever the OS. */
const posixRelative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/** Every Rust file a command could be declared in. */
export function rustCommandFiles(): string[] {
  return walk(RUST_SRC, [".rs"]);
}

/**
 * Command handlers as *declared*: every `fn` carrying `#[tauri::command]`,
 * with the files that declare it.
 *
 * The attribute must start its own line. `skills.rs` once cited `#[tauri::command]`
 * inside a `//!` module doc comment, and matching that occurrence sent the
 * scan past it to the next unrelated `fn` (an `impl Default`), inventing a
 * command called `default`.
 *
 * Taking the *next* `fn` after the attribute, rather than one regex spanning
 * both, tolerates additional attributes stacked between the two — a
 * fixed-lookahead pattern would silently skip those handlers.
 */
export function declaredCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  // `(async)` and other attribute arguments count: `#[tauri::command(async)]`
  // moves a sync handler off the main thread and is still a command.
  const attribute = /^[ \t]*#\[tauri::command(\([^)]*\))?\]/gm;
  for (const file of rustCommandFiles()) {
    const src = readFileSync(file, "utf8");
    for (const attr of src.matchAll(attribute)) {
      const match = src.slice(attr.index + attr[0].length).match(/\bfn\s+([a-z_][a-z0-9_]*)/i);
      if (!match) continue;
      const name = match[1];
      found.set(name, [...(found.get(name) ?? []), posixRelative(file)]);
    }
  }
  return found;
}

/**
 * Command handlers as *registered* in `tauri::generate_handler![...]`, in
 * order, duplicates kept. Declaring a `#[tauri::command]` is not enough for
 * the app to answer it. The list is read by bracket depth, so a nested `[...]`
 * inside it can never end it early.
 */
export function registeredCommands(): string[] {
  return bracketBody(readFileSync(LIB_RS, "utf8"), "generate_handler![", {
    open: "[",
    lang: "rust",
    where: "src-tauri/src/lib.rs",
  })
    .split(",")
    .map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop()!);
}

/**
 * Comments are removed before scanning, for the same reason as on the Rust
 * side: prose citing a command name should not be able to assert that it
 * exists. `//` only opens a comment when it isn't the tail of `https://`-style
 * text inside a string (the `[^:]` guard); that is imprecise but errs toward
 * keeping code, never toward keeping a comment.
 */
export function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * The optional type argument between `invoke` and `(`. Balanced angle
 * brackets up to four levels deep — `invoke<Record<string, Array<X>>>("…")` —
 * and `=>` inside a function type doesn't count as a closing bracket. The old
 * `<[^>]*>` stopped at the first `>`, so every call with a nested generic
 * (`models_pricing_get`, `capture_screenshot`, …) went unchecked.
 */
const TYPE_ARG = (() => {
  const atom = "(?:=>|[^<>])";
  let level = `<${atom}*>`;
  for (let i = 0; i < 3; i++) level = `<(?:${atom}|${level})*>`;
  return level;
})();

/** `invoke<…>("name"` — the name may sit on the line after the `(`. */
export const INVOKE_LITERAL = new RegExp(
  `\\binvoke\\s*(?:${TYPE_ARG})?\\s*\\(\\s*["'\`]([a-zA-Z0-9_]+)["'\`]`,
  "g",
);

/** `invoke<…>(someVariable` — a command name a literal scan cannot read. */
export const INVOKE_DYNAMIC = new RegExp(
  `\\binvoke\\s*(?:${TYPE_ARG})?\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`,
  "g",
);

/**
 * The call sites that pass `invoke` a variable, keyed by file, with the
 * literal command names that flow into that variable in the same file. A
 * literal scan can't follow data flow, so each site is listed by hand;
 * `ipc-contract` checks that the list is complete (a new dynamic site fails
 * until it is added here), that each literal still appears in its file, and
 * that each is registered.
 *
 * Empty, and best kept so: a wrapper per command (`hunkOps` in
 * `git-changes-api.ts` is three) keeps every name a literal the scan reads.
 */
export const DYNAMIC_INVOKE_SITES: Record<string, string[]> = {};
