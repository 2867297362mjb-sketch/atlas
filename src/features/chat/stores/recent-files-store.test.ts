// The `@` picker's "Recent files" mirror Rust's queue. A rename never hands
// the new list back to its caller, so the only way the picker stops offering
// the old path is the `atlas:recent-files-changed` event. This runs that loop
// against the mock backend's own handlers: the rename command, the event it
// emits, and the store that hears it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

import { invoke } from "@tauri-apps/api/core";
import { MOCK_PROJECT } from "@/dev/mock-backend/project";
import { renameRecentFile } from "@/features/explorer/lib/fs-api";
import { useProjectStore } from "@/features/projects/stores/project-store";
import {
  ensureRecentFilesListener,
  useRecentFilesStore,
  type RecentFile,
} from "./recent-files-store";

const shown = () => useRecentFilesStore.getState().items.map((item) => item.absPath);

beforeEach(async () => {
  await tauri.useScenario();
  useProjectStore.setState({ activeProjectId: MOCK_PROJECT.id });
  ensureRecentFilesListener();
  // What App.tsx does when a project opens.
  const items = await invoke<RecentFile[]>("recent_files_open_project", {
    workspaceId: MOCK_PROJECT.id,
  });
  useRecentFilesStore.getState().actions.hydrate(items);
});

describe("recent files", () => {
  it("follows a rename, which reaches the store only through the event", async () => {
    const [first, ...rest] = shown();
    const renamed = `${first}.renamed`;

    await renameRecentFile(first, renamed, MOCK_PROJECT.id);

    expect(shown()).toEqual([renamed, ...rest]);
  });

  it("keeps the visible list when another project's queue changes", async () => {
    const before = shown();

    await tauri.emit("atlas:recent-files-changed", {
      workspaceId: "some-background-project",
      project: "/elsewhere",
      items: [{ absPath: "/elsewhere/a.ts", rel: "a.ts", touchedAt: 1 }],
    });

    expect(shown()).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});
