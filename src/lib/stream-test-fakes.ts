/**
 * Test doubles for `frame-coalesced-stream.ts`: a frame scheduler that fires
 * only when told to, and timers on a clock that only moves when advanced.
 * Tests of the stream and of everything built on it (the agent event router,
 * the comms envelope stream) share these, so none of them sleeps.
 */
import type { FrameScheduler, StreamTimers } from "./frame-coalesced-stream";

export interface FakeScheduler {
  frames: FrameScheduler;
  timers: StreamTimers;
  /** Run every frame callback requested so far (one animation frame). */
  frame(): void;
  /** Move the clock forward, firing due timers in order. Frames do not fire:
   *  that is the unfocused/hidden window. */
  advance(ms: number): void;
  pendingFrames(): number;
  pendingTimers(): number;
}

export function createFakeScheduler(): FakeScheduler {
  let now = 0;
  let nextHandle = 1;
  const frameQueue = new Map<number, () => void>();
  const timerQueue = new Map<number, { at: number; callback: () => void }>();

  return {
    frames: {
      request(callback) {
        const handle = nextHandle++;
        frameQueue.set(handle, callback);
        return handle;
      },
      cancel(handle) {
        frameQueue.delete(handle);
      },
    },
    timers: {
      set(callback, ms) {
        const handle = nextHandle++;
        timerQueue.set(handle, { at: now + ms, callback });
        return handle;
      },
      clear(handle) {
        timerQueue.delete(handle as number);
      },
      now: () => now,
    },
    frame() {
      const due = [...frameQueue.values()];
      frameQueue.clear();
      for (const callback of due) callback();
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timerQueue) {
          if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
        }
        if (!next) break;
        timerQueue.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = target;
    },
    pendingFrames: () => frameQueue.size,
    pendingTimers: () => timerQueue.size,
  };
}
