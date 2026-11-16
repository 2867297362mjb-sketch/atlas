/**
 * Frame-coalesced text deltas for a token stream: the batch policy the side
 * chat (Session Chat) puts on `frame-coalesced-stream.ts`. Its store used to
 * apply one zustand `set()` (full Record spread + subscriber notification +
 * panel render + virtualizer measure) PER STREAMED TOKEN: 100+ render/measure
 * cycles a second at fast providers, where the main chat caps at one per
 * frame.
 *
 * The policy: deltas join per key (stream id), and a batch is handed over as
 * one map, its keys in the order each stream was first heard from. When the
 * batch is drained (once per animation frame, or by the backstop timer in a
 * window whose frames are paused) is the stream's business; see that module.
 *
 * Call `flush()` before handling a terminal event (done/error) so the last
 * chunks are applied before the stream mapping is torn down and the session
 * persisted.
 */
import { createFrameCoalescedStream, type StreamBatch } from "./frame-coalesced-stream";

export interface StreamDeltaBuffer {
  /** Queue `delta` under `key`; schedules a flush if none is pending. */
  push: (key: string, delta: string) => void;
  /** Apply everything now (cancels the scheduled drains). Safe to call idle. */
  flush: () => void;
}

const BACKSTOP_MS = 250;

/** One stream's text for one batch. A tuple, so it is also a map entry. */
type Chunk = [key: string, text: string];

/** Joins each key's deltas into the entry made by its first one. */
function joinByKey(): StreamBatch<Chunk> {
  const items: Chunk[] = [];
  const byKey = new Map<string, Chunk>();
  return {
    items,
    add([key, delta]) {
      const chunk = byKey.get(key);
      if (chunk) {
        chunk[1] += delta;
        return;
      }
      const first: Chunk = [key, delta];
      byKey.set(key, first);
      items.push(first);
    },
  };
}

export function createStreamDeltaBuffer(
  apply: (chunks: ReadonlyMap<string, string>) => void,
): StreamDeltaBuffer {
  const stream = createFrameCoalescedStream<Chunk>({
    sink: (chunks) => apply(new Map(chunks)),
    newBatch: joinByKey,
    backstopMs: BACKSTOP_MS,
    // The batch is lost either way; what must not happen is the exception
    // killing the scheduler (every later delta would then buffer against a
    // drain that never runs — the thread "freezes" mid-answer).
    onSinkError: (e, dropped) =>
      console.error("stream delta flush failed; dropped", dropped.length, "streams:", e),
  });

  return {
    push: (key, delta) => stream.push([key, delta]),
    flush: () => stream.flush(),
  };
}
