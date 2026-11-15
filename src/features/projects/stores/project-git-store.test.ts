// The project switcher's git summaries keep up on their own: the store reads a
// project's summary once, then re-reads it when Rust says that project's git
// state or working tree changed. The events are delivered here as Rust
// delivers them, through `listen`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

import { useProjectGitStore, type GitSummary } from "./project-git-store";

/** The branch each repository is on, as Rust would report it. */
const branchOf: Record<string, string> = {};
const summary = (branch: string): GitSummary => ({
  isRepo: true,
  branch,
  headSubject: "",
  dirty: false,
  additions: 0,
  deletions: 0,
});

const shown = (path: string) => useProjectGitStore.getState().summaries[path]?.branch;
const reads = () => tauri.calls("git_workspace_summary").map((call) => call.args.path);

/** Open a project in the switcher and wait for its first summary. */
async function open(path: string, branch: string) {
  branchOf[path] = branch;
  useProjectGitStore.getState().actions.ensure(path);
  await vi.waitFor(() => expect(shown(path)).toBe(branch));
}

beforeEach(() => {
  // Not `tauri.reset()`: the store subscribes once for the app's lifetime, and
  // a reset would drop that subscriber for every later test.
  tauri.invoke.mockClear();
  tauri.handle({ git_workspace_summary: ({ path }) => summary(branchOf[path]) });
});
afterEach(() => vi.useRealTimers());

describe("project git summaries", () => {
  it("re-reads a project's summary when git reports a change to it", async () => {
    await open("/repo/a", "main");

    branchOf["/repo/a"] = "feature";
    await tauri.emit("atlas:git-changed", { project: "/repo/a" });

    await vi.waitFor(() => expect(shown("/repo/a")).toBe("feature"));
  });

  it("does not read a project the switcher never showed", async () => {
    await open("/repo/b", "main");
    tauri.invoke.mockClear();

    await tauri.emit("atlas:git-changed", { project: "/repo/never-opened" });
    await tauri.emit("atlas:git-changed", {});

    expect(reads()).toEqual([]);
  });

  it("reads once for a burst of edits under a project, and not at all for edits beside it", async () => {
    await open("/repo/c", "main");
    tauri.invoke.mockClear();
    vi.useFakeTimers();

    await tauri.emit("atlas:explorer:changed", { dirs: ["/repo/c-sibling/src"] });
    await vi.advanceTimersByTimeAsync(300);
    expect(reads()).toEqual([]);

    for (let i = 0; i < 5; i++) {
      await tauri.emit("atlas:explorer:changed", { dirs: ["/repo/c/src"] });
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(reads()).toEqual(["/repo/c"]);
  });
});
