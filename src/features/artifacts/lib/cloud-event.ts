/**
 * The cloud bridge's one window channel, read once.
 *
 * Rust forwards every frame from the Workspace sockets on
 * `atlas:artifacts-cloud`, flat and `kind`-tagged (`WireEvent` in
 * `commands/artifacts_cloud.rs`). Three listeners follow it: the Timeline
 * board (`use-timeline-board.ts`), an open Session's comments
 * (`use-session-comments.ts`) and the presence roster (`team-presence.ts`).
 * They used to narrow the payload each in their own way; this is the one
 * parse, and each listener switches on its result.
 *
 * # What a `resync` asks of each listener
 *
 * A `resync` means the bridge fell behind and frames were dropped, so what a
 * listener holds may have a gap it cannot see. They answer differently, and
 * the difference is deliberate for two and a gap for the third:
 *
 * - the **board** drops every cached Session detail and re-reads the board;
 * - the **comments** of the open Session are re-read;
 * - **presence** does nothing. A roster is only ever pushed: there is no
 *   command that reads one, so there is nothing to re-read, and clearing it
 *   would show nobody online until the next person came or went. A roster
 *   frame lost to the lag therefore stays lost until that Project's roster
 *   next changes. Closing that gap needs the bridge to re-announce rosters
 *   after a lag.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Comment } from "./comments-api";

/** The window channel the cloud bridge emits on. */
export const ARTIFACTS_EVENT = "atlas:artifacts-cloud";

export type CloudEvent =
  /** The Organisation's board has rows it did not have. */
  | { kind: "boardChanged" }
  /** One row of a Session's timeline was added or changed. */
  | { kind: "entryUpsert"; sessionId: string; change: string; entry: unknown }
  /** A comment was posted, edited, resolved or deleted: one shape for all. */
  | { kind: "commentUpsert"; sessionId: string; comment: Comment }
  /** A server Project's whole roster, never a delta. */
  | { kind: "presence"; projectId: string; online: string[] }
  /** This account lost its membership of a server Project. */
  | { kind: "revoked"; projectId: string }
  /** Frames were dropped; see the module docblock. */
  | { kind: "resync" };

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * A raw payload as a `CloudEvent`, or `null` for one no listener should act
 * on: a kind this build does not know, or a known kind missing a field its
 * readers use. The `comment` and `entry` bodies are passed through as sent.
 */
export function parseCloudEvent(raw: unknown): CloudEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  switch (frame.kind) {
    case "boardChanged":
      return { kind: "boardChanged" };
    case "resync":
      return { kind: "resync" };
    case "entryUpsert":
      if (!isId(frame.sessionId) || typeof frame.change !== "string") return null;
      return {
        kind: "entryUpsert",
        sessionId: frame.sessionId,
        change: frame.change,
        entry: frame.entry,
      };
    case "commentUpsert":
      if (!isId(frame.sessionId)) return null;
      if (typeof frame.comment !== "object" || frame.comment === null) return null;
      return {
        kind: "commentUpsert",
        sessionId: frame.sessionId,
        comment: frame.comment as Comment,
      };
    case "presence":
      if (!isId(frame.projectId) || !Array.isArray(frame.online)) return null;
      if (!frame.online.every((id) => typeof id === "string")) return null;
      return { kind: "presence", projectId: frame.projectId, online: frame.online };
    case "revoked":
      if (!isId(frame.projectId)) return null;
      return { kind: "revoked", projectId: frame.projectId };
    default:
      return null;
  }
}

/** Follow the channel. Frames `parseCloudEvent` refuses never reach `handler`. */
export function listenCloudEvents(handler: (event: CloudEvent) => void): Promise<UnlistenFn> {
  return listen<unknown>(ARTIFACTS_EVENT, (event) => {
    const parsed = parseCloudEvent(event.payload);
    if (parsed) handler(parsed);
  });
}
