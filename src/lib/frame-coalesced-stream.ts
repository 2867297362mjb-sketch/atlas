/**
 * A frame-coalesced stream: items pushed at the rate a socket or an IPC channel
 * delivers them, handed to a sink at most once per animation frame.
 *
 * Why it exists. An event applied on arrival is one store write, one subscriber
 * notification and one React commit PER EVENT. A tool-heavy agent turn, a team
 * chat backfill or a presence storm delivers dozens per frame, which pegs the
 * main thread. Buffering and draining once per frame turns the burst into one
 * commit (React batches every `set` inside the synchronous drain).
 *
 * What it owns, so no caller has to get it right again:
 *
 * - **Order.** Items reach the sink in the order the batch holds them, and the
 *   batch (the caller's coalescing policy) decides that order.
 * - **Two drains.** A frame alone is not a guarantee that the buffer is ever
 *   emptied. WebKit pauses `requestAnimationFrame` whenever the WKWebView isn't
 *   frontmost, not just when it's hidden. A user who leaves Atlas on screen
 *   while working in another app is watching a window whose frame queue is
 *   stopped: items keep arriving and keep buffering, and NOTHING renders. The
 *   whole stream then lands in one batch the instant something wakes the
 *   webview, which reads as "it was stuck, then it caught up". `setTimeout` is
 *   throttled in that state (to roughly a second) but never paused, so the
 *   backstop timer is the drain that always eventually fires. When frames are
 *   healthy the frame wins every race and clears the backstop, so this costs
 *   one cancelled timer per frame and changes nothing about normal streaming.
 * - **The hold.** A caller may ask for a drain to wait (a scroll gesture in
 *   flight); the hold is capped, so it can delay a batch but never starve it.
 * - **Teardown.** `dispose` cancels the pending frame and timer and makes every
 *   later `push`/`flush` a no-op, which is what keeps a React StrictMode
 *   double-mount, or an event that arrives while its listener is still being
 *   removed, from scheduling work against a torn-down owner.
 *
 * Its dependencies are passed in (the sink, the frame scheduler, the timers and
 * clock, the hold predicate), so a test drives it with fakes and never sleeps.
 */

/** The coalescing policy for one batch: everything pushed between two drains.
 *  `add` decides whether an item appends, merges into an earlier entry or
 *  replaces one; `items` is what the sink receives, in order. A fresh batch is
 *  made for every drain, so a policy keeps its bookkeeping (positions, keys) in
 *  its own closure and never has to reset it. */
export interface StreamBatch<T> {
  add(item: T): void;
  readonly items: T[];
}

/** `requestAnimationFrame` in production. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** `setTimeout` and a monotonic clock in production. */
export interface StreamTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /** Monotonic milliseconds; only read when a hold is configured. */
  now(): number;
}

export interface StreamHold {
  /** True while a drain should wait. */
  active(): boolean;
  /** Longest a batch may be held, measured from its oldest item. */
  maxMs: number;
  /** How soon a held drain is tried again. */
  retryMs: number;
}

export interface FrameCoalescedStreamOptions<T> {
  /** Receives each drained batch, in order. Never called with an empty batch. */
  sink(items: T[]): void;
  /** The coalescing policy. Omitted: items append in arrival order. */
  newBatch?: () => StreamBatch<T>;
  /** How long buffered items may wait when no frame fires. */
  backstopMs: number;
  hold?: StreamHold;
  /**
   * Called when the sink throws. The batch is already out of the buffer, so it
   * is lost either way: re-queueing a batch that throws would just loop on it
   * forever. Given this, the error stops here. Omitted, the error propagates to
   * whoever triggered the drain (the frame or timer callback, or the caller of
   * `flush`). In both cases the stream has already reset itself, so the next
   * `push` schedules a fresh drain: a throwing sink never wedges the stream.
   */
  onSinkError?: (error: unknown, dropped: T[]) => void;
  frames?: FrameScheduler;
  timers?: StreamTimers;
}

export interface FrameCoalescedStream<T> {
  /** Buffer an item and make sure a drain is scheduled. */
  push(item: T): void;
  /**
   * Drain now, synchronously, cancelling the scheduled drains. A plain `flush()`
   * still respects the hold; `flush(true)` does not. Safe to call when idle.
   */
  flush(force?: boolean): void;
  /** Cancel everything pending and ignore every later call. Buffered items
   *  are dropped, not drained: the owner is going away. */
  dispose(): void;
}

export const browserFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export const browserTimers: StreamTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

function appendBatch<T>(): StreamBatch<T> {
  const items: T[] = [];
  return { items, add: (item) => void items.push(item) };
}

export function createFrameCoalescedStream<T>(
  options: FrameCoalescedStreamOptions<T>,
): FrameCoalescedStream<T> {
  const { sink, backstopMs, hold, onSinkError } = options;
  const newBatch = options.newBatch ?? appendBatch<T>;
  const frames = options.frames ?? browserFrames;
  const timers = options.timers ?? browserTimers;

  let batch = newBatch();
  let frame: number | null = null;
  /** Timer drain that survives frames being paused. */
  let backstop: { handle: unknown } | null = null;
  /** When the oldest un-drained item was buffered (null = buffer empty). */
  let oldestBufferedAt: number | null = null;
  let disposed = false;

  const cancelDrains = () => {
    if (frame !== null) {
      frames.cancel(frame);
      frame = null;
    }
    if (backstop !== null) {
      timers.clear(backstop.handle);
      backstop = null;
    }
  };

  const flush = (force = false) => {
    if (disposed) return;
    cancelDrains();
    if (batch.items.length === 0) {
      oldestBufferedAt = null;
      return;
    }
    // Held: the items keep buffering and land the moment the hold lifts or its
    // cap expires. Only the timer is re-armed here; the next `push` asks for a
    // frame again.
    if (
      !force &&
      hold &&
      hold.active() &&
      oldestBufferedAt !== null &&
      timers.now() - oldestBufferedAt < hold.maxMs
    ) {
      backstop = { handle: timers.set(() => flush(), hold.retryMs) };
      return;
    }
    oldestBufferedAt = null;
    const items = batch.items;
    batch = newBatch();
    if (!onSinkError) {
      sink(items);
      return;
    }
    try {
      sink(items);
    } catch (error) {
      // What must NOT happen is the exception escaping into the frame/timer
      // callback and taking the scheduler down with it: every later item would
      // then buffer against a drain that never runs again, which presents as
      // the stream freezing.
      onSinkError(error, items);
    }
  };

  const push = (item: T) => {
    if (disposed) return;
    batch.add(item);
    if (hold && oldestBufferedAt === null) oldestBufferedAt = timers.now();
    if (frame === null) frame = frames.request(() => flush());
    if (backstop === null) backstop = { handle: timers.set(() => flush(), backstopMs) };
  };

  const dispose = () => {
    if (disposed) return;
    cancelDrains();
    disposed = true;
  };

  return { push, flush, dispose };
}
