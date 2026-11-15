// @vitest-environment happy-dom
//
// What clears "unread" and "Woke" (ADR-0028): the session in front of the
// user is marked viewed, 1.5 s after it got there. "In front of the user" is
// the active tab's session with the window focused; a turn still running is
// not something they have seen the end of.
//
// Rust decides what unread means. This hook only decides when to tell it the
// user looked, and that is the whole of the frontend's part in it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useChatStore } from "../stores/chat-store";
import { VIEWED_DEBOUNCE_MS } from "../stores/session-lifecycle-store";
import { useMarkActiveSessionViewed } from "./use-mark-session-viewed";

const store = () => useChatStore.getState();
const viewed = () => tauri.calls("threads_mark_viewed").map((c) => c.args.sessionId);
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const windowEvent = (name: "focus" | "blur") =>
  act(() => {
    window.dispatchEvent(new Event(name));
  });

let focused = true;

function open(tabId: string, sessionId: string | null) {
  const { actions } = store();
  actions.createSession(tabId, "atlas-agent");
  if (sessionId) actions.setAcpBinding(tabId, "agent-1", sessionId, "/proj");
}
const activate = (tabId: string | null) => act(() => store().actions.setActiveSession(tabId));

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.handleRaw({ threads_mark_viewed: () => true });
  localStorage.clear();
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  open("tab-a", "sess-a");
  open("tab-b", "sess-b");
  open("tab-new", null);
  store().actions.setActiveSession(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useMarkActiveSessionViewed", () => {
  it("restates the debounce: 1.5 s", () => {
    expect(VIEWED_DEBOUNCE_MS).toBe(1_500);
  });

  it("marks the active session 1.5 s after it comes to the front, once", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");

    await advance(VIEWED_DEBOUNCE_MS - 1);
    expect(viewed()).toEqual([]);
    await advance(1);
    expect(viewed()).toEqual(["sess-a"]);

    await advance(60_000);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("does not mark a session the user only passed through", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    activate("tab-b");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-b"]);
  });

  it("has nothing to mark for a tab with no session yet, until it is bound", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-new");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual([]);

    act(() => store().actions.setAcpBinding("tab-new", "agent-1", "sess-new", "/proj"));
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-new"]);
  });

  it("leaves a session unread while the window is in the background, and marks it on return", async () => {
    focused = false;
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(60_000);
    expect(viewed()).toEqual([]);

    focused = true;
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    expect(viewed()).toEqual([]);
    await advance(1);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("does not mark when the window loses focus inside the 1.5 s", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    windowEvent("blur");
    await advance(60_000);
    expect(viewed()).toEqual([]);
  });

  it("waits for a running turn: the completion is seen when it finishes in front of the user", async () => {
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(60_000);
    expect(viewed()).toEqual([]);

    act(() => store().actions.updateSessionStatus("tab-a", "idle"));
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("a turn that finishes while the user is away stays unread until they come back", async () => {
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    focused = false;
    windowEvent("blur");

    act(() => store().actions.updateSessionStatus("tab-a", "idle"));
    await advance(60_000);
    expect(viewed()).toEqual([]);

    focused = true;
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("as found: a focus during a running turn marks it viewed before it has finished", async () => {
    // The mount-and-activate path waits for the turn (above); the focus
    // listener does not ask whether one is running.
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("stops with its component: no mark after unmount, and no listeners left", async () => {
    const { unmount } = renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    unmount();
    windowEvent("focus");
    await advance(60_000);
    expect(viewed()).toEqual([]);
  });

  it("a failed mark is quiet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri.handleRaw({ threads_mark_viewed: () => Promise.reject(new Error("locked")) });
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
