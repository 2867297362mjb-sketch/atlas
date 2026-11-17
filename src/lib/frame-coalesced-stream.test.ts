// The frame-coalesced stream, driven only through `push` / `flush` / `dispose`
// with a fake frame scheduler and a fake clock.
//
// Two production streams sit on this module (agent session deltas, team chat
// envelopes) and what it guards is invisible everywhere else: an item applied
// out of order, a buffer that never drains in an unfocused window, a scroll
// hold that starves the stream, or a drain scheduled against a torn-down owner
// all type-check, lint and render. Each case below is one of those.

import { describe, expect, it, vi } from "vitest";
import {
  createFrameCoalescedStream,
  type FrameCoalescedStreamOptions,
  type StreamBatch,
} from "./frame-coalesced-stream";
import { createFakeScheduler } from "./stream-test-fakes";

const BACKSTOP_MS = 250;

function setup<T = string>(over: Partial<FrameCoalescedStreamOptions<T>> = {}) {
  const scheduler = createFakeScheduler();
  const batches: T[][] = [];
  const stream = createFrameCoalescedStream<T>({
    sink: (items) => void batches.push(items),
    backstopMs: BACKSTOP_MS,
    frames: scheduler.frames,
    timers: scheduler.timers,
    ...over,
  });
  return { scheduler, batches, stream };
}

/** A policy that merges adjacent items starting with the same letter, and
 *  treats "|" as an item nothing merges across. */
function runMergingBatch(): StreamBatch<string> {
  const items: string[] = [];
  return {
    items,
    add(item) {
      const last = items[items.length - 1];
      if (last && item !== "|" && last !== "|" && last[0] === item[0]) {
        items[items.length - 1] = last + item;
      } else {
        items.push(item);
      }
    },
  };
}

describe("draining", () => {
  it("drains on the next frame, in arrival order, as one batch", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    stream.push("b");
    stream.push("c");
    expect(batches).toEqual([]);
    scheduler.frame();
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  it("asks for one frame and one backstop per batch, however many items", () => {
    const { scheduler, stream } = setup();
    stream.push("a");
    stream.push("b");
    stream.push("c");
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTimers()).toBe(1);
  });

  it("starts a new batch after each drain", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    scheduler.frame();
    stream.push("b");
    scheduler.frame();
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("clears the backstop when the frame wins, so nothing drains twice", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    scheduler.frame();
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.advance(BACKSTOP_MS * 4);
    expect(batches).toEqual([["a"]]);
  });

  it("never calls the sink with an empty batch", () => {
    const { scheduler, batches, stream } = setup();
    stream.flush();
    stream.flush(true);
    scheduler.frame();
    scheduler.advance(BACKSTOP_MS);
    expect(batches).toEqual([]);
  });
});

describe("the coalescing policy", () => {
  it("applies within a frame", () => {
    const { scheduler, batches, stream } = setup({ newBatch: runMergingBatch });
    stream.push("a1");
    stream.push("a2");
    stream.push("b1");
    scheduler.frame();
    expect(batches).toEqual([["a1a2", "b1"]]);
  });

  it("a run-breaking item splits the coalescing on either side of it", () => {
    const { scheduler, batches, stream } = setup({ newBatch: runMergingBatch });
    stream.push("a1");
    stream.push("a2");
    stream.push("|");
    stream.push("a3");
    stream.push("a4");
    scheduler.frame();
    expect(batches).toEqual([["a1a2", "|", "a3a4"]]);
  });

  it("does not coalesce across a drain: each batch starts from a fresh policy", () => {
    const newBatch = vi.fn(runMergingBatch);
    const { scheduler, batches, stream } = setup({ newBatch });
    stream.push("a1");
    scheduler.frame();
    stream.push("a2");
    scheduler.frame();
    expect(batches).toEqual([["a1"], ["a2"]]);
    // One up front, one after each drain.
    expect(newBatch).toHaveBeenCalledTimes(3);
  });
});

describe("a forced flush", () => {
  it("drains synchronously and in order", () => {
    const { batches, stream } = setup();
    stream.push("a");
    stream.push("b");
    stream.flush(true);
    expect(batches).toEqual([["a", "b"]]);
  });

  it("cancels the scheduled frame and backstop", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    stream.flush(true);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.frame();
    scheduler.advance(BACKSTOP_MS);
    expect(batches).toEqual([["a"]]);
  });

  it("keeps what was flushed ahead of what is pushed after it", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    stream.flush(true);
    stream.push("b");
    scheduler.frame();
    expect(batches).toEqual([["a"], ["b"]]);
  });
});

describe("when frames never fire (an unfocused or hidden window)", () => {
  it("the backstop drains after its timeout, not before", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    stream.push("b");
    scheduler.advance(BACKSTOP_MS - 1);
    expect(batches).toEqual([]);
    scheduler.advance(1);
    expect(batches).toEqual([["a", "b"]]);
    // The frame that never fired is not left behind to drain again later.
    expect(scheduler.pendingFrames()).toBe(0);
  });

  it("keeps draining batch after batch on the backstop alone", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    scheduler.advance(BACKSTOP_MS);
    stream.push("b");
    scheduler.advance(BACKSTOP_MS);
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("measures the backstop from the first item of the batch", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    scheduler.advance(200);
    stream.push("b");
    scheduler.advance(50);
    expect(batches).toEqual([["a", "b"]]);
  });
});

describe("the hold", () => {
  const HOLD = { maxMs: 400, retryMs: 100 };
  function held() {
    const state = { hot: true };
    const s = setup({ hold: { ...HOLD, active: () => state.hot } });
    return { ...s, state };
  }

  it("delays a drain while it is active, and keeps buffering", () => {
    const { scheduler, batches, stream } = held();
    stream.push("a");
    scheduler.frame();
    expect(batches).toEqual([]);
    stream.push("b");
    scheduler.frame();
    expect(batches).toEqual([]);
  });

  it("drains on the retry once the hold lifts", () => {
    const { scheduler, batches, stream, state } = held();
    stream.push("a");
    scheduler.frame();
    state.hot = false;
    scheduler.advance(HOLD.retryMs - 1);
    expect(batches).toEqual([]);
    scheduler.advance(1);
    expect(batches).toEqual([["a"]]);
  });

  it("drains on the next frame once the hold lifts, if an item brings one", () => {
    const { scheduler, batches, stream, state } = held();
    stream.push("a");
    scheduler.frame();
    state.hot = false;
    stream.push("b");
    scheduler.frame();
    expect(batches).toEqual([["a", "b"]]);
  });

  it("never holds a batch beyond the cap, even if the hold never lifts", () => {
    const { scheduler, batches, stream } = held();
    stream.push("a");
    scheduler.frame();
    scheduler.advance(HOLD.maxMs - 1);
    expect(batches).toEqual([]);
    scheduler.advance(1);
    expect(batches).toEqual([["a"]]);
  });

  it("never holds beyond the cap with frames firing and items still arriving", () => {
    const { scheduler, batches, stream } = held();
    stream.push("a");
    for (let t = 0; t < HOLD.maxMs; t += 16) {
      scheduler.frame();
      expect(batches).toEqual([]);
      scheduler.advance(16);
      stream.push("b");
    }
    scheduler.frame();
    expect(batches).toHaveLength(1);
    expect(batches[0][0]).toBe("a");
  });

  it("measures the cap from the oldest item of each batch, not the first ever", () => {
    const { scheduler, batches, stream } = held();
    stream.push("a");
    scheduler.frame();
    scheduler.advance(HOLD.maxMs);
    expect(batches).toEqual([["a"]]);
    stream.push("b");
    scheduler.frame();
    // A fresh batch gets a fresh hold.
    expect(batches).toEqual([["a"]]);
    scheduler.advance(HOLD.maxMs - 1);
    expect(batches).toEqual([["a"]]);
    scheduler.advance(1);
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("with frames paused too, the cap is checked on the timers: backstop, then each retry", () => {
    const { scheduler, batches, stream } = held();
    stream.push("a");
    // 250 (backstop, held) → 350 (retry, held) → 450 (retry, past the cap).
    scheduler.advance(BACKSTOP_MS + HOLD.retryMs * 2 - 1);
    expect(batches).toEqual([]);
    scheduler.advance(1);
    expect(batches).toEqual([["a"]]);
  });

  it("is respected by a plain flush and overridden by a forced one", () => {
    const { batches, stream } = held();
    stream.push("a");
    stream.flush();
    expect(batches).toEqual([]);
    stream.flush(true);
    expect(batches).toEqual([["a"]]);
  });

  it("is not consulted when there is nothing to drain", () => {
    const active = vi.fn(() => true);
    const { stream } = setup({ hold: { ...HOLD, active } });
    stream.flush();
    expect(active).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("cancels the pending frame and timer and drops what was buffered", () => {
    const { scheduler, batches, stream } = setup();
    stream.push("a");
    stream.dispose();
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.frame();
    scheduler.advance(BACKSTOP_MS);
    expect(batches).toEqual([]);
  });

  it("cancels a hold's retry timer", () => {
    const { scheduler, batches, stream } = setup({
      hold: { active: () => true, maxMs: 400, retryMs: 100 },
    });
    stream.push("a");
    scheduler.frame();
    stream.dispose();
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.advance(1_000);
    expect(batches).toEqual([]);
  });

  it("ignores a push after it: nothing is scheduled and nothing reaches the sink", () => {
    const { scheduler, batches, stream } = setup();
    stream.dispose();
    stream.push("a");
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    stream.flush(true);
    expect(batches).toEqual([]);
  });

  it("is safe to call twice (a StrictMode double cleanup)", () => {
    const { stream } = setup();
    stream.push("a");
    stream.dispose();
    expect(() => stream.dispose()).not.toThrow();
  });

  it("leaves a second stream on the same scheduler untouched", () => {
    const scheduler = createFakeScheduler();
    const batches: string[][] = [];
    const make = () =>
      createFrameCoalescedStream<string>({
        sink: (items) => void batches.push(items),
        backstopMs: BACKSTOP_MS,
        frames: scheduler.frames,
        timers: scheduler.timers,
      });
    // Mount, unmount, mount again.
    const first = make();
    first.push("stale");
    first.dispose();
    const second = make();
    second.push("live");
    scheduler.frame();
    expect(batches).toEqual([["live"]]);
  });
});

describe("a sink that throws", () => {
  it("with onSinkError: reports the dropped batch and keeps streaming", () => {
    const onSinkError = vi.fn();
    const seen: string[][] = [];
    const boom = new Error("boom");
    const { scheduler, stream } = setup({
      sink: (items) => {
        if (items.includes("bad")) throw boom;
        seen.push(items);
      },
      onSinkError,
    });
    stream.push("bad");
    stream.push("also lost");
    expect(() => scheduler.frame()).not.toThrow();
    expect(onSinkError).toHaveBeenCalledWith(boom, ["bad", "also lost"]);
    // The failed batch is not retried, and the next one drains normally.
    stream.push("good");
    scheduler.frame();
    expect(seen).toEqual([["good"]]);
    expect(onSinkError).toHaveBeenCalledTimes(1);
  });

  it("with onSinkError: a forced flush does not throw into its caller", () => {
    const onSinkError = vi.fn();
    const { stream } = setup({
      sink: () => {
        throw new Error("boom");
      },
      onSinkError,
    });
    stream.push("a");
    expect(() => stream.flush(true)).not.toThrow();
    expect(onSinkError).toHaveBeenCalledTimes(1);
  });

  it("without onSinkError: the error propagates, and the stream is not wedged", () => {
    const seen: string[][] = [];
    const { scheduler, stream } = setup({
      sink: (items) => {
        if (items.includes("bad")) throw new Error("boom");
        seen.push(items);
      },
    });
    stream.push("bad");
    expect(() => scheduler.frame()).toThrow("boom");
    expect(scheduler.pendingTimers()).toBe(0);
    stream.push("good");
    scheduler.frame();
    expect(seen).toEqual([["good"]]);
  });

  it("on the backstop path too", () => {
    const onSinkError = vi.fn();
    const seen: string[][] = [];
    const { scheduler, stream } = setup({
      sink: (items) => {
        if (items.includes("bad")) throw new Error("boom");
        seen.push(items);
      },
      onSinkError,
    });
    stream.push("bad");
    scheduler.advance(BACKSTOP_MS);
    stream.push("good");
    scheduler.advance(BACKSTOP_MS);
    expect(seen).toEqual([["good"]]);
  });
});
