// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

const invoke = tauri.invoke;
const healthChanged = (cwd: string) => void tauri.emit("atlas:memory-health", { cwd });

import { healthLine, useMemoryHealth, type HealthStatus } from "./use-memory-health";

const status = (checkedAt: number): HealthStatus => ({
  checkedAt,
  record: { checkedAt, found: [], repaired: [], deferred: [] },
  corpus: { rebuiltVectors: 0, rebuiltFts: false, recreated: false },
  restored: null,
});

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
});
afterEach(() => vi.useRealTimers());

describe("useMemoryHealth", () => {
  it("reads on mount and re-reads once after a burst of health events for its project", async () => {
    invoke.mockResolvedValue(status(1));
    const { result } = renderHook(() => useMemoryHealth("/repo"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current?.checkedAt).toBe(1);
    invoke.mockResolvedValue(status(2));
    await act(async () => {
      for (let i = 0; i < 5; i++) healthChanged("/repo");
      healthChanged("/other");
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current?.checkedAt).toBe(2);
  });
});

describe("healthLine", () => {
  it("says what the last pass did", () => {
    expect(healthLine(null)).toBeNull();
    expect(healthLine(status(1))).toBe("Memory healthy");
    const repaired = {
      ...status(1),
      record: { ...status(1).record, repaired: [{ kind: "fts_drift" }] },
    };
    expect(healthLine(repaired)).toBe("Memory repaired 1 issue");
    const deferred = {
      ...status(1),
      record: { ...status(1).record, deferred: [{ kind: "vectors_missing" }] },
    };
    expect(healthLine(deferred)).toBe("Memory needs attention: vectors_missing");
    expect(healthLine({ ...status(1), restored: [5, true] })).toBe(
      "Memory was damaged and restored from yesterday's snapshot",
    );
    expect(healthLine({ ...status(1), archived: 3 })).toBe("Memory healthy · archived 3 unused");
  });

  it("names an outside edit of the history", () => {
    const broken = {
      ...status(1),
      record: { ...status(1).record, deferred: [{ kind: "chain_broken", firstBadRev: 4 }] },
    };
    expect(healthLine(broken)).toBe("Memory history was edited outside Atlas");
  });
});
