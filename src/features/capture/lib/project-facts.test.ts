// @vitest-environment happy-dom
//
// The Session card's body remounts on every expand. The facts it shows must
// come from a cache that is read ONCE, re-read on the events that can change
// them, and ignore the per-turn capture traffic that cannot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

const answerAs = (mode: "cloud" | "local") =>
  tauri.handleRaw({
    capture_binding: () => ({ mode, slug: mode === "cloud" ? "atlas" : null, orgId: null }),
    capture_detect: () => ({ root: "/p" }),
  });
const captureChanged = (payload: unknown) => void tauri.emit("atlas:capture-changed", payload);

const { useProjectFacts, invalidateProjectFacts, resetProjectFactsCache } =
  await import("./project-facts");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetProjectFactsCache();
  // Not `tauri.reset()`: the module subscribes once for its lifetime, and a
  // reset would drop that subscriber for every later test.
  tauri.invoke.mockClear();
  answerAs("cloud");
});
afterEach(() => vi.useRealTimers());

const reads = () => tauri.calls("capture_binding").length;

describe("useProjectFacts", () => {
  it("reads once, and a remount paints from the cache with no read", async () => {
    const first = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(first.result.current).toBeDefined());
    first.unmount();
    const second = renderHook(() => useProjectFacts("/p"));
    expect(second.result.current?.binding?.slug).toBe("atlas"); // same frame
    expect(reads()).toBe(1);
  });

  it("ignores recording writes and re-reads on a sync-state change", async () => {
    const { result } = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(result.current).toBeDefined());
    act(() => captureChanged({ sessionIds: ["as-1"], all: false }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(reads()).toBe(1);
    act(() => captureChanged(null));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(reads()).toBe(2);
  });

  it("re-reads when the capture setup is changed, and updates only on a difference", async () => {
    const { result } = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(result.current).toBeDefined());
    const before = result.current;
    await act(async () => invalidateProjectFacts("/p"));
    await waitFor(() => expect(reads()).toBe(2));
    expect(result.current).toBe(before); // same answer, same object
    answerAs("local");
    await act(async () => invalidateProjectFacts("/p"));
    await waitFor(() => expect(result.current?.binding?.mode).toBe("local"));
  });
});
