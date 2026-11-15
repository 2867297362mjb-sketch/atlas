// The text-delta buffer, driven only through `push` / `flush`, on a fake
// frame scheduler and a fake clock.
//
// The buffer takes no scheduler: it reads `requestAnimationFrame` and
// `setTimeout` from the page. So the fakes are installed as those globals,
// which pins what it does and when without saying how it is built. These
// cases were written against the buffer's own rAF-and-timer machinery and
// pass unchanged now that it is a batch policy on the frame-coalesced stream.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamDeltaBuffer } from "./stream-delta-buffer";
import { createFakeScheduler, type FakeScheduler } from "./stream-test-fakes";

const BACKSTOP_MS = 250;

let scheduler: FakeScheduler;

beforeEach(() => {
  scheduler = createFakeScheduler();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    scheduler.frames.request(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => scheduler.frames.cancel(handle));
  vi.stubGlobal("setTimeout", (callback: () => void, ms: number) =>
    scheduler.timers.set(callback, ms),
  );
  vi.stubGlobal("clearTimeout", (handle: unknown) => scheduler.timers.clear(handle));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A buffer, and every batch it applied as `[key, text]` pairs in map order. */
function setup() {
  const batches: Array<Array<[string, string]>> = [];
  const buffer = createStreamDeltaBuffer((chunks) => void batches.push([...chunks]));
  return { buffer, batches };
}

describe("coalescing", () => {
  it("applies nothing until a frame, then everything in one call", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "Hel");
    buffer.push("s1", "lo");
    expect(batches).toEqual([]);

    scheduler.frame();

    expect(batches).toEqual([[["s1", "Hello"]]]);
  });

  it("joins each stream's deltas in arrival order", () => {
    const { buffer, batches } = setup();
    for (const delta of ["a", "b", "c", "d"]) buffer.push("s1", delta);

    scheduler.frame();

    expect(batches).toEqual([[["s1", "abcd"]]]);
  });

  it("keeps streams apart, in the order each was first heard from", () => {
    const { buffer, batches } = setup();
    buffer.push("s2", "x");
    buffer.push("s1", "a");
    buffer.push("s2", "y");
    buffer.push("s3", "!");
    buffer.push("s1", "b");

    scheduler.frame();

    expect(batches).toEqual([
      [
        ["s2", "xy"],
        ["s1", "ab"],
        ["s3", "!"],
      ],
    ]);
  });

  it("starts each batch empty: a stream's earlier text is not applied twice", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "one");
    scheduler.frame();
    buffer.push("s1", " two");
    scheduler.frame();

    expect(batches).toEqual([[["s1", "one"]], [["s1", " two"]]]);
  });

  it("an empty delta still counts as that stream having spoken", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "");

    scheduler.frame();

    expect(batches).toEqual([[["s1", ""]]]);
  });

  it("hands over a map later pushes do not change", () => {
    const seen: Array<ReadonlyMap<string, string>> = [];
    const buffer = createStreamDeltaBuffer((chunks) => void seen.push(chunks));
    buffer.push("s1", "a");
    scheduler.frame();
    buffer.push("s1", "b");
    buffer.push("s2", "c");
    scheduler.frame();

    expect([...seen[0]]).toEqual([["s1", "a"]]);
  });
});

describe("scheduling", () => {
  it("asks for one frame and one timer, however many deltas arrive", () => {
    const { buffer } = setup();
    for (let i = 0; i < 50; i++) buffer.push(`s${i % 3}`, "x");

    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTimers()).toBe(1);
  });

  it("schedules nothing while idle", () => {
    setup();

    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it("the frame clears the backstop, so one batch is applied once", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    scheduler.frame();

    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.advance(BACKSTOP_MS * 4);
    expect(batches).toHaveLength(1);
  });

  it("with no frames (an unfocused window) the backstop applies it", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");

    scheduler.advance(BACKSTOP_MS - 1);
    expect(batches).toEqual([]);
    scheduler.advance(1);

    expect(batches).toEqual([[["s1", "a"]]]);
  });

  it("the backstop runs from the batch's first delta: later ones do not push it back", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    scheduler.advance(200);
    buffer.push("s1", "b");
    scheduler.advance(50);

    expect(batches).toEqual([[["s1", "ab"]]]);
  });

  it("the backstop cancels the frame it beat", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    scheduler.advance(BACKSTOP_MS);

    expect(scheduler.pendingFrames()).toBe(0);
    scheduler.frame();
    expect(batches).toHaveLength(1);
  });

  it("keeps draining a long unfocused stream, one batch per backstop", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    scheduler.advance(BACKSTOP_MS);
    buffer.push("s1", "b");
    scheduler.advance(BACKSTOP_MS);

    expect(batches).toEqual([[["s1", "a"]], [["s1", "b"]]]);
  });

  it("a delta after a drain schedules a fresh frame and timer", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    scheduler.frame();
    buffer.push("s1", "b");

    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTimers()).toBe(1);
    scheduler.frame();
    expect(batches).toHaveLength(2);
  });
});

describe("flush", () => {
  it("applies everything now and cancels both scheduled drains", () => {
    const { buffer, batches } = setup();
    buffer.push("s1", "a");
    buffer.push("s2", "b");

    buffer.flush();

    expect(batches).toEqual([
      [
        ["s1", "a"],
        ["s2", "b"],
      ],
    ]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.frame();
    scheduler.advance(BACKSTOP_MS * 4);
    expect(batches).toHaveLength(1);
  });

  it("is a no-op while idle: nothing is applied, nothing scheduled", () => {
    const { buffer, batches } = setup();

    buffer.flush();
    buffer.flush();

    expect(batches).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  it("applies the last chunks before the caller handles a terminal event", () => {
    const order: string[] = [];
    const buffer = createStreamDeltaBuffer(
      (chunks) => void order.push(`apply:${chunks.get("s1")}`),
    );
    buffer.push("s1", "tail");

    buffer.flush();
    order.push("done");

    expect(order).toEqual(["apply:tail", "done"]);
  });
});

describe("a delta pushed while a batch is being applied", () => {
  it("goes into the next batch, with its own frame", () => {
    const batches: Array<Array<[string, string]>> = [];
    const buffer = createStreamDeltaBuffer((chunks) => {
      batches.push([...chunks]);
      if (batches.length === 1) buffer.push("s1", "late");
    });
    buffer.push("s1", "first");

    scheduler.frame();
    expect(batches).toEqual([[["s1", "first"]]]);
    expect(scheduler.pendingFrames()).toBe(1);

    scheduler.frame();
    expect(batches).toEqual([[["s1", "first"]], [["s1", "late"]]]);
  });
});

describe("an apply that throws", () => {
  it("is logged with how many streams were dropped, and does not escape", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("store exploded");
    const buffer = createStreamDeltaBuffer(() => {
      throw failure;
    });
    buffer.push("s1", "a");
    buffer.push("s2", "b");
    buffer.push("s1", "c");

    expect(() => scheduler.frame()).not.toThrow();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "stream delta flush failed; dropped",
      2,
      "streams:",
      failure,
    );
  });

  it("does not escape a direct flush either", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const buffer = createStreamDeltaBuffer(() => {
      throw new Error("store exploded");
    });
    buffer.push("s1", "a");

    expect(() => buffer.flush()).not.toThrow();
  });

  it("drops that batch and keeps streaming: the next delta is applied", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const batches: Array<Array<[string, string]>> = [];
    let fail = true;
    const buffer = createStreamDeltaBuffer((chunks) => {
      if (fail) throw new Error("store exploded");
      batches.push([...chunks]);
    });
    buffer.push("s1", "lost");
    scheduler.frame();
    fail = false;

    buffer.push("s1", "kept");
    expect(scheduler.pendingFrames()).toBe(1);
    scheduler.frame();

    expect(batches).toEqual([[["s1", "kept"]]]);
  });
});
