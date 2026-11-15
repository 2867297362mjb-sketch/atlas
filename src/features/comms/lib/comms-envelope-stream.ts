/**
 * Team chat's envelope stream: socket frames from Rust, applied once per
 * animation frame.
 *
 * A burst of socket frames (a backfill, a reaction flood, a presence storm)
 * used to be one zustand `set`, and one React commit, PER FRAME of the socket.
 * Buffer and drain once per animation frame; React batches every `set` inside
 * the synchronous drain into a single commit. The timeout backstop drains
 * while the window is hidden, where frames never fire (the same trap as the
 * agent delta stream, and the same module: `frame-coalesced-stream.ts`).
 *
 * Envelopes are not merged or deduplicated: each one is applied, in arrival
 * order.
 */
import {
  createFrameCoalescedStream,
  type FrameCoalescedStream,
  type FrameScheduler,
  type StreamTimers,
} from "@/lib/frame-coalesced-stream";
import type { CommsEnvelope } from "./comms-api";

/** How long buffered envelopes may wait when no frame fires. */
export const COMMS_BACKSTOP_MS = 120;

export interface CommsEnvelopeStreamDeps {
  /** Apply one envelope to the comms store. */
  apply(envelope: CommsEnvelope): void;
  /** Runs after `apply` for the same envelope, so "on screen" and names are
   *  current when the notifier reads them. */
  notify(envelope: CommsEnvelope): void;
  frames?: FrameScheduler;
  timers?: StreamTimers;
}

export function createCommsEnvelopeStream(
  deps: CommsEnvelopeStreamDeps,
): FrameCoalescedStream<CommsEnvelope> {
  return createFrameCoalescedStream<CommsEnvelope>({
    sink: (batch) => {
      for (const envelope of batch) {
        deps.apply(envelope);
        deps.notify(envelope);
      }
    },
    backstopMs: COMMS_BACKSTOP_MS,
    frames: deps.frames,
    timers: deps.timers,
  });
}
