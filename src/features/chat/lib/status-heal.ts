/**
 * The backstop for a chat tab whose status no longer matches its session's.
 *
 * Rust owns whether a session's turn is running; a tab holds a copy, kept
 * current by deltas. A delta that never arrives (a projection closed early,
 * a kill with no terminal, a turn numbered behind a stale mark) leaves the
 * copy wrong for good, and the wrong it is left in is almost always "Working":
 * a Stop button and a sidebar card ticking up for a turn that ended long ago.
 * Each such cause is fixed where it was found; this is what keeps the next
 * one from being a stuck tab. When a tab is shown, and every so often while
 * it says it is busy, it reads its session's status back from Rust
 * (`agents_snapshot_meta`, no transcript) and adopts it.
 *
 * Adopting is careful in both directions, because a snapshot is a read from a
 * moment ago racing deltas that are newer:
 * - The tab says busy and Rust says not: only once the turn has had time to
 *   start (a send marks the tab running before Rust has the turn), and only
 *   when Rust has seen at least the tab's turn.
 * - Rust says busy and the tab says not: only for a turn newer than any the
 *   tab knows. The same turn, busy in an older read, is one whose end the tab
 *   has already applied.
 */
import { isBusyAgentStatus } from "@/types/agent";
import type { SessionSnapshot } from "@/types/agents";
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";
import { snapshotLive } from "./snapshot-message";

/** How long a tab may say busy before a "not busy" read is believed. A send
 *  reaches Rust in milliseconds; this is generous on purpose. */
export const HEAL_SETTLE_MS = 15_000;

/** What the heal asks of the backend. A parameter so a test can answer. */
export interface HealDeps {
  readStatus: (key: { agent_id: string; session_id: string }) => Promise<SessionSnapshot>;
  now: () => number;
}

const appDeps: HealDeps = { readStatus: agents.snapshotMeta, now: () => Date.now() };

/** Reads in flight, so a show and a timer firing together read once. */
const inFlight = new Set<string>();

/** Read `tabId`'s session status from Rust and correct the tab's copy when it
 *  is provably behind. A no-op for a tab with no session, or one still
 *  loading, starting or restarting its session. */
export async function healStatus(tabId: string, deps: HealDeps = appDeps): Promise<void> {
  const before = useChatStore.getState().sessions[tabId];
  if (!before?.acpAgentId || !before.acpSessionId) return;
  if (before.transcriptLoading || before.resumePending || before.disconnected) return;
  if (inFlight.has(tabId)) return;
  inFlight.add(tabId);
  let snapshot: SessionSnapshot;
  try {
    snapshot = await deps.readStatus({
      agent_id: before.acpAgentId,
      session_id: before.acpSessionId,
    });
  } catch {
    // Unknown session, agent gone: the disconnect path owns those.
    return;
  } finally {
    inFlight.delete(tabId);
  }
  const { sessions, actions } = useChatStore.getState();
  const now = sessions[tabId];
  if (!now || now.acpSessionId !== before.acpSessionId) return;
  if (now.transcriptLoading || now.resumePending || now.disconnected) return;
  const rustSeq = snapshot.turn_seq;
  // A backend that does not report its turn cannot be compared: leave it.
  if (rustSeq === undefined) return;
  const ourSeq = now.currentTurnSeq ?? 0;
  const busyHere = isBusyAgentStatus(now.status);
  const busyThere = isBusyAgentStatus(snapshot.status);

  if (busyHere && !busyThere) {
    if (rustSeq < ourSeq) return;
    const startedAt = now.turnStartedAt;
    if (startedAt == null || deps.now() - startedAt < HEAL_SETTLE_MS) return;
    // Through the reducer, as the terminal Rust would have sent: it sweeps
    // the tool calls still spinning, clears Stop's "Stopping…" and drops
    // permission prompts the turn left behind.
    actions.applyAgentDelta({
      kind: "status",
      agent_id: now.acpAgentId ?? before.acpAgentId,
      session_id: now.acpSessionId,
      seq: 0,
      status: snapshot.status,
      turn_seq: rustSeq,
    });
    return;
  }
  if (busyThere && (!busyHere || now.status !== snapshot.status)) {
    // A turn the tab never heard start (a wake, another window, a queued
    // prompt), or a prompt waiting on the user that the tab does not show:
    // adopt the live state, open prompts included.
    if (!busyHere && rustSeq <= ourSeq) return;
    if (busyHere && rustSeq < ourSeq) return;
    actions.hydrateSessionSnapshot(
      tabId,
      snapshot.status,
      snapshot.plan,
      undefined,
      snapshotLive(snapshot),
    );
  }
}
