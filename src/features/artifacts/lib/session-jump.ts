/**
 * `atlas:session-chat-jump`: moves a Session's timeline to an entry or a
 * commit.
 *
 * A source chip in the Session chat fires it and the detail listens and jumps
 * — an event rather than a prop so the chat needs no handle on the detail's
 * internals, and a citation rendered anywhere works the same way. A window
 * `CustomEvent`, TS to TS, so `event-contract` does not see it.
 */
import { emitWindowEvent } from "@/lib/window-events";

export interface JumpDetail {
  entryId?: string;
  commitSha?: string;
}

/** The one place this event is dispatched. */
export function jumpTo(detail: JumpDetail): void {
  emitWindowEvent("atlas:session-chat-jump", detail);
}
