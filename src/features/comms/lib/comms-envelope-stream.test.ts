// Team chat's envelope stream: its batching rule, through the shared
// frame-coalesced stream, with a fake frame scheduler and a fake clock.
//
// The rule is small (no merging, apply then notify, per envelope) but nothing
// else checks it: an envelope notified before the store holds it raises a
// banner with a stale name or for a conversation that is on screen.

import { describe, expect, it } from "vitest";
import { createFakeScheduler } from "@/lib/stream-test-fakes";
import type { CommsEnvelope } from "./comms-api";
import { COMMS_BACKSTOP_MS, createCommsEnvelopeStream } from "./comms-envelope-stream";

/** The stream never reads an envelope, so a tagged stand-in is enough. */
const envelope = (tag: string) => ({ tag }) as unknown as CommsEnvelope;

function setup(apply?: (envelope: CommsEnvelope) => void) {
  const scheduler = createFakeScheduler();
  const calls: Array<[string, CommsEnvelope]> = [];
  const stream = createCommsEnvelopeStream({
    apply: (e) => {
      apply?.(e);
      calls.push(["apply", e]);
    },
    notify: (e) => void calls.push(["notify", e]),
    frames: scheduler.frames,
    timers: scheduler.timers,
  });
  return { scheduler, calls, stream };
}

describe("the comms envelope stream", () => {
  it("applies a burst on the next frame: each envelope applied, then notified, in arrival order", () => {
    const { scheduler, calls, stream } = setup();
    const [a, b, c] = [envelope("a"), envelope("b"), envelope("c")];
    stream.push(a);
    stream.push(b);
    stream.push(c);
    expect(calls).toEqual([]);
    scheduler.frame();
    expect(calls).toEqual([
      ["apply", a],
      ["notify", a],
      ["apply", b],
      ["notify", b],
      ["apply", c],
      ["notify", c],
    ]);
  });

  it("does not merge or drop repeated envelopes", () => {
    const { scheduler, calls, stream } = setup();
    const same = envelope("same");
    stream.push(same);
    stream.push(same);
    scheduler.frame();
    expect(calls.filter((c) => c[0] === "apply")).toHaveLength(2);
  });

  it("drains on its backstop while the window is hidden and frames never fire", () => {
    const { scheduler, calls, stream } = setup();
    const a = envelope("a");
    stream.push(a);
    scheduler.advance(COMMS_BACKSTOP_MS - 1);
    expect(calls).toEqual([]);
    scheduler.advance(1);
    expect(calls).toEqual([
      ["apply", a],
      ["notify", a],
    ]);
  });

  it("an envelope the store throws on loses the rest of its batch, not the stream", () => {
    const { scheduler, calls, stream } = setup((e) => {
      if (e === bad) throw new Error("boom");
    });
    const bad = envelope("bad");
    const after = envelope("after");
    const next = envelope("next");
    stream.push(bad);
    stream.push(after);
    // The error surfaces from the frame, as an uncaught one would.
    expect(() => scheduler.frame()).toThrow("boom");
    expect(calls).toEqual([]);
    stream.push(next);
    scheduler.frame();
    expect(calls).toEqual([
      ["apply", next],
      ["notify", next],
    ]);
  });

  it("dispose cancels the pending drain and ignores what arrives after it", () => {
    const { scheduler, calls, stream } = setup();
    stream.push(envelope("a"));
    stream.dispose();
    stream.push(envelope("b"));
    scheduler.frame();
    scheduler.advance(COMMS_BACKSTOP_MS);
    expect(calls).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });
});
