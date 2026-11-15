import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

// Imported the way app code imports them: through the modules the fake replaces.
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, once } from "@tauri-apps/api/event";
import { tauri } from "./tauri-fake";

// Commands no fixture declares and Rust does not register. Named here rather
// than inline: `tests/ipc-contract.test.ts` reads every `invoke("…")` literal
// in `src/` as a call the app really makes.
const UNKNOWN = "never_heard_of_it";
const UNTYPED = "untyped_command";

beforeEach(() => tauri.reset());

describe("invoke", () => {
  it("resolves null for a command nothing handles, as the mock backend does", async () => {
    await expect(invoke(UNKNOWN, { a: 1 })).resolves.toBeNull();
  });

  it("rejects an unhandled command under strict()", async () => {
    tauri.strict();
    await expect(invoke(UNKNOWN)).rejects.toThrow(`no handler for "${UNKNOWN}"`);
  });

  it("answers from a handler, which gets the args the app passed", async () => {
    tauri.handle({ git_diff_file: (args) => `diff-of:${args.path}` });
    await expect(invoke("git_diff_file", { path: "a.ts" })).resolves.toBe("diff-of:a.ts");
  });

  it("hands a handler {} when the app passed no args", async () => {
    tauri.handleRaw({ [UNTYPED]: (args) => Object.keys(args).length });
    await expect(invoke(UNTYPED)).resolves.toBe(0);
  });

  it("turns a handler's throw into a rejection, as a failed command arrives", async () => {
    tauri.handle({
      git_tags: () => {
        throw new Error("not a repository");
      },
    });
    await expect(invoke("git_tags", { repoPath: "/x" })).rejects.toThrow("not a repository");
  });

  it("keeps earlier handlers when more are added, and lets a later one replace a command", async () => {
    tauri.handle({ git_tags: () => ["v1"] });
    tauri.handleRaw({ [UNTYPED]: () => "1.0.0" });
    tauri.handle({ git_tags: () => ["v2"] });
    await expect(invoke("git_tags")).resolves.toEqual(["v2"]);
    await expect(invoke(UNTYPED)).resolves.toBe("1.0.0");
  });

  it("checks a typed handler's answer against what the frontend reads", () => {
    // @ts-expect-error -- `git_tags` answers a list of names, not a number.
    tauri.handle({ git_tags: () => 7 });
    // @ts-expect-error -- not a command any fixture declares; `handleRaw` takes those.
    tauri.handle({ never_heard_of_it: () => null });
    tauri.handle({ git_tags: () => ["v1"], git_diff_file: async () => "" });
  });

  it("hands a streaming command a channel it can push through", async () => {
    tauri.handleRaw({
      [UNTYPED]: (args) => {
        args.onChunk.onmessage(1);
        args.onChunk.onmessage(2);
        return "done";
      },
    });
    const onChunk = new Channel<number>();
    const seen: number[] = [];
    onChunk.onmessage = (n) => seen.push(n);
    await expect(invoke(UNTYPED, { onChunk })).resolves.toBe("done");
    expect(seen).toEqual([1, 2]);
  });

  it("leaves an asset path as it is", () => {
    expect(convertFileSrc("/tmp/a.png")).toBe("/tmp/a.png");
  });
});

describe("the call log", () => {
  it("records every call in order, with {} for no args", async () => {
    await invoke("git_tags", { n: 1 });
    await invoke("git_log");
    await invoke("git_tags", { n: 2 });
    expect(tauri.calls()).toEqual([
      { cmd: "git_tags", args: { n: 1 } },
      { cmd: "git_log", args: {} },
      { cmd: "git_tags", args: { n: 2 } },
    ]);
  });

  it("narrows to one command", async () => {
    await invoke("git_tags", { n: 1 });
    await invoke("git_log");
    await invoke("git_tags", { n: 2 });
    expect(tauri.calls("git_tags").map((call) => call.args.n)).toEqual([1, 2]);
    expect(tauri.calls("git_show")).toEqual([]);
  });

  it("is the same record the invoke spy keeps", async () => {
    await invoke("git_tags", { n: 1 });
    expect(invoke).toHaveBeenCalledWith("git_tags", { n: 1 });
    expect(tauri.invoke).toBe(invoke);
  });
});

describe("events", () => {
  it("delivers an emitted payload to a subscriber as { payload }", async () => {
    const seen: unknown[] = [];
    await listen<{ repo: string }>("atlas:git-changed", (event) => seen.push(event.payload));
    await tauri.emit("atlas:git-changed", { repo: "/repo" });
    expect(seen).toEqual([{ repo: "/repo" }]);
  });

  it("delivers before emit returns, and resolves once async subscribers have", async () => {
    const order: string[] = [];
    await listen("atlas:x", async () => {
      order.push("started");
      await Promise.resolve();
      order.push("finished");
    });
    const delivered = tauri.emit("atlas:x");
    expect(order).toEqual(["started"]);
    await delivered;
    expect(order).toEqual(["started", "finished"]);
  });

  it("reaches every subscriber of the channel and no other channel's", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    await listen("atlas:x", a);
    await listen("atlas:x", b);
    await listen("atlas:y", other);
    await tauri.emit("atlas:x", 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it("stops delivering after unlisten, to that subscriber only", async () => {
    const gone = vi.fn();
    const stays = vi.fn();
    const unlisten = await listen("atlas:x", gone);
    await listen("atlas:x", stays);
    expect(tauri.listenerCount("atlas:x")).toBe(2);
    unlisten();
    expect(tauri.listenerCount("atlas:x")).toBe(1);
    await tauri.emit("atlas:x");
    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);
  });

  it("delivers to a once() subscriber a single time", async () => {
    const seen = vi.fn();
    await once("atlas:x", seen);
    await tauri.emit("atlas:x", "a");
    await tauri.emit("atlas:x", "b");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0].payload).toBe("a");
    expect(tauri.listenerCount("atlas:x")).toBe(0);
  });

  it("delivers what the app itself emits to its own subscribers", async () => {
    const seen = vi.fn();
    await listen("atlas:x", seen);
    await emit("atlas:x", { from: "app" });
    expect(seen.mock.calls[0][0].payload).toEqual({ from: "app" });
    expect(emit).toHaveBeenCalledWith("atlas:x", { from: "app" });
  });
});

describe("reset", () => {
  it("drops handlers, strictness, subscribers and recorded calls", async () => {
    tauri.handle({ git_tags: () => ["v1"] });
    tauri.strict();
    const seen = vi.fn();
    await listen("atlas:x", seen);
    await invoke("git_tags");

    tauri.reset();

    expect(tauri.calls()).toEqual([]);
    expect(tauri.listenerCount("atlas:x")).toBe(0);
    await tauri.emit("atlas:x");
    expect(seen).not.toHaveBeenCalled();
    await expect(invoke("git_tags")).resolves.toBeNull();
  });

  it("puts the handler table back behind a spy a test overrode", async () => {
    tauri.invoke.mockResolvedValue("overridden");
    await expect(invoke(UNTYPED)).resolves.toBe("overridden");
    tauri.reset();
    tauri.handleRaw({ [UNTYPED]: () => "handled" });
    await expect(invoke(UNTYPED)).resolves.toBe("handled");
  });
});

// A long timeout: the first test to name a scenario imports every scenario's
// fixtures, which takes seconds when the whole suite is running beside it.
describe("useScenario", { timeout: 30_000 }, () => {
  it("answers with the mock backend's base handlers", async () => {
    await tauri.useScenario();
    const catalog = await invoke<{ themes: unknown[] }>("list_themes");
    expect(catalog.themes.length).toBeGreaterThan(0);
  });

  it("lets a test's own handler outrank the scenario's", async () => {
    await tauri.useScenario();
    tauri.handleRaw({ list_themes: () => "mine" });
    await expect(invoke("list_themes")).resolves.toBe("mine");
  });

  it("still resolves null for a command the scenario does not answer", async () => {
    await tauri.useScenario();
    await expect(invoke(UNKNOWN)).resolves.toBeNull();
  });

  it("puts a named scenario's commands over the base", async () => {
    await tauri.useScenario();
    const base = await invoke<{ exists: boolean }>("keybindings_load");
    await tauri.useScenario("fresh-install");
    const fresh = await invoke<{ exists: boolean }>("keybindings_load");
    // A fresh install has no keybindings file yet; the base scenario has one.
    expect([base.exists, fresh.exists]).toEqual([true, false]);
    // What the scenario does not override is still the base's.
    const catalog = await invoke<{ themes: unknown[] }>("list_themes");
    expect(catalog.themes.length).toBeGreaterThan(0);
  });

  it("refuses a scenario that does not exist", async () => {
    await expect(tauri.useScenario("no-such-scenario")).rejects.toThrow("unknown scenario");
  });
});

/**
 * The fake imports `vitest`, and through `useScenario` the mock backend's
 * fixtures. One import of it from app code would put both in the bundle, and
 * nothing else would notice: it typechecks, lints and runs.
 */
describe("the fake stays out of the app", () => {
  const SRC = path.resolve(import.meta.dirname, "..");
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  it("is imported only by test files and by itself", () => {
    const importers = sources(SRC)
      .filter((file) => !/\.test\.tsx?$/.test(file) && path.dirname(file) !== import.meta.dirname)
      .filter((file) => /["'](@\/test\/|(\.\.\/)+test\/)/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(importers).toEqual([]);
  });
});
