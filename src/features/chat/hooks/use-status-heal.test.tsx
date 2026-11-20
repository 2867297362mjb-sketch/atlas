// @vitest-environment happy-dom
//
// When the status backstop reads: on a tab being shown, and on a timer while
// the tab says it is busy, shown or not (a hidden tab's status is its sidebar
// card's).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { HEAL_EVERY_MS, useStatusHeal } from "./use-status-heal";

const TAB = "chat-1";
const OTHER = "chat-2";

const reads = () => tauri.calls("agents_snapshot_meta").length;
const chatTab = (id: string) =>
  ({ id, type: "chat", title: "Session", closable: true, dirty: false, data: {} }) as never;

function show(active: string) {
  useLayoutStore.setState({
    tabs: [chatTab(TAB), chatTab(OTHER)],
    groupOrder: ["main"],
    activeByGroup: { main: active },
    focusedGroupId: "main",
    activeTabId: active,
    viewsByWs: {},
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.handleRaw({ agents_snapshot_meta: () => Promise.reject(new Error("unknown session")) });
  localStorage.clear();
  useChatStore.setState({ sessions: {}, pendingPermissions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", "acp-1", "/proj");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useLayoutStore.setState({ tabs: [], activeByGroup: {}, activeTabId: null, viewsByWs: {} });
});

describe("useStatusHeal", () => {
  it("reads when the tab is shown, not while it is hidden and idle", async () => {
    show(OTHER);
    renderHook(() => useStatusHeal(TAB));
    await act(() => vi.advanceTimersByTimeAsync(HEAL_EVERY_MS * 2));
    expect(reads()).toBe(0);

    act(() => show(TAB));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reads()).toBe(1);
  });

  it("reads on a timer while the tab says it is busy, hidden or not", async () => {
    show(OTHER);
    act(() => useChatStore.getState().actions.updateSessionStatus(TAB, "running"));
    renderHook(() => useStatusHeal(TAB));
    await act(() => vi.advanceTimersByTimeAsync(HEAL_EVERY_MS * 2));
    expect(reads()).toBe(2);

    act(() => useChatStore.getState().actions.updateSessionStatus(TAB, "idle"));
    await act(() => vi.advanceTimersByTimeAsync(HEAL_EVERY_MS * 2));
    expect(reads()).toBe(2);
  });
});
