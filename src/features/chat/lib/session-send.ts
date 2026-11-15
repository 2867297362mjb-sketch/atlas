/**
 * Sending to a session: the one place a send, a stop and a drain are carried
 * out. `send-gate.ts` decides; this does what it decided, through the agents
 * port and the chat store it is handed, and owns the window's side of the
 * session's prompt queue.
 *
 * The panel's handlers and its drain effect are thin callers: a handler turns
 * a UI event into `send` / `stop`, the effect turns a state change into one
 * `tick`. Everything a test needs is a parameter (`SessionSendDeps`), so the
 * whole path runs against an in-memory agents fake.
 *
 * # The queue
 *
 * The queue belongs to the session, in Rust — the turn controller beside
 * `AgentHost` (`src-tauri/src/commands/agent_host/steering.rs`). It drains the
 * next prompt when a turn ends, discards the queue on Stop, and announces every
 * change as a whole-queue `queue_changed` delta, which the chat store mirrors
 * into `queues[tabId]` (what the composer's queued-message strip renders). It
 * used to be React state drained by a React effect, which a remote driver
 * could not reach and a closed tab took with it.
 *
 * Two kinds of item live in the strip, told apart by `queueIds[tabId]`:
 *
 * - **Mirrored** (a Rust item id) — the session is bound, and Rust has it.
 * - **Local** (`null`) — typed while the tab has no session Rust can hold a
 *   queue for (still starting, a resume loading, the agent process gone).
 *   Flushed into Rust, in order, at the next bind.
 *
 * Plus `pending:` markers: an add that is on its way to Rust, shown at once
 * and replaced by the delta (or turned local if the add failed).
 *
 * The window's send gates — a resume still loading, a mode it could not
 * restore, a session live in another process, no AI grant, an agent switch
 * waiting on `/remember` — pause the Rust queue rather than holding items
 * back here (`setHold`), so the drain decision stays in one place.
 *
 * What the window remembers about a tab's queue beyond the store (adds on
 * their way, why it is held, what Rust was last told) lives in the instance
 * `createSessionSend` returns, for as long as that instance does: the app has
 * one (`sessionSend`), a test makes its own.
 */
import { logEvent } from "@/features/log/lib/log";
import { noteSessionSent } from "@/features/tips/lib/session-sent";
import { pluginIdForAgent, type ChatSession, type PendingSend } from "@/types/agent";
import type { ImageAttachment, SessionKey } from "@/types/agents";
import { grantLocksComposer, hasNoAiGrant } from "../stores/ai-grant-store";
import { useChatStore } from "../stores/chat-store";
import { isSendHeldElsewhere } from "../stores/live-elsewhere-store";
import { useRcStore } from "../stores/rc-store";
import { rebindDisconnectedSession } from "./agent-rebind";
import { agents, resetAgent } from "./agents-api";
import type { MentionData } from "./mentions";
import { trustedMentionPaths } from "./picked-mentions";
import { inlineQueuedText } from "./queued-text";
import { drivenElsewhere } from "./rc-api";
import { decide, sendGate, sendStateOf, type SendSession, type SendState } from "./send-gate";
import { projectPathForTab } from "./tab-project";
import { composeWirePrompt, queuedWirePrompt, type WirePrompt } from "./wire-prompt";

/** What the send path asks of the agents backend (`agents-api.ts`). */
export type AgentsPort = Pick<
  typeof agents,
  | "send"
  | "cancel"
  | "kill"
  | "killPlugin"
  | "queueAdd"
  | "queueRemove"
  | "queueClear"
  | "queuePause"
  | "queueDrain"
>;

type ChatState = ReturnType<typeof useChatStore.getState>;

export interface SessionSendDeps {
  agents: AgentsPort;
  /** The chat store, read at an action boundary. */
  chat: () => Pick<ChatState, "sessions" | "queues" | "queueIds" | "actions">;
  /** What other stores know about a session: live elsewhere, the grant hold,
   *  a remote driver. */
  ambient: (
    session: ChatSession | undefined,
  ) => Pick<SendState, "heldElsewhere" | "grantHold" | "remoteDriving">;
  /** Restart a session whose agent process died; `false` if it could not. */
  rebind: (tabId: string) => Promise<boolean>;
  /** Forget the cached agent of a plugin whose connection was just killed. */
  forgetAgent: (pluginId: string) => void;
  /** What the agent is sent for a message, and for a queued prompt. */
  wirePrompt: (
    acpSessionId: string,
    content: string,
    mentions: MentionData[],
  ) => Promise<WirePrompt>;
  queuedPrompt: (text: string) => string;
}

export interface OutgoingMessage {
  content: string;
  mentions: MentionData[];
  attachments?: ImageAttachment[];
}

export interface SendOptions {
  /** The user bubble, title and running status were already applied when
   *  this message was held as `pendingSend`; only dispatch. */
  recorded?: boolean;
  /** That bubble's id, when the caller knows it. */
  clientMessageId?: string;
  /** Make sure a bind is running for a message held for one (`BindControl.kick`). */
  kickBind?: () => void;
}

/** What a panel shows its drain: the render's session and the two holds the
 *  render subscribed to. */
export interface DrainView {
  session: SendSession | undefined;
  heldElsewhere: boolean;
  grantHold: boolean;
}

export interface SessionSend {
  /** The tab's send-relevant state right now. */
  state(tabId: string): SendState;
  /** Send a message: dispatch it, hold it as the first message, or queue it. */
  send(tabId: string, message: OutgoingMessage, opts?: SendOptions): Promise<void>;
  /** Stop: the turn, or a session that is still starting. `abandonBind` is
   *  the panel's `BindControl.abandon`. */
  stop(tabId: string, abandonBind?: () => void): void;
  /** One mounted panel's drain. `tick` on every change to what it shows; it
   *  remembers the last snapshot, so the edges are found here, not by the
   *  caller. */
  watch(tabId: string, opts?: Pick<SendOptions, "kickBind">): { tick(view: DrainView): void };

  /** Park `text` behind the running turn. Never sent by itself. */
  enqueue(tabId: string, text: string, mentions: readonly MentionData[]): void;
  /** Take the strip's `index`-th item out (its chip's ✕, or "edit"). */
  removeQueued(tabId: string, index: number): void;
  /** Discard everything queued for the tab, leaving a running turn alone. */
  clearQueued(tabId: string): void;
  /** Take every queued prompt's text out of the queue. */
  takeQueued(tabId: string): string[];
  /** Hand the bound session every local item, then — with `drain` — start the head. */
  flushLocal(tabId: string, opts: { drain: boolean }): Promise<void>;
  /** The session Rust can hold this tab's queue for, or `null` while there is none. */
  queueKey(tabId: string): SessionKey | null;
  /** Hold (`on`) or release the tab's queue for `reason`. */
  setHold(tabId: string, reason: QueueHoldReason, on: boolean): void;
  /** Forget a closed tab's queue bookkeeping. */
  forget(tabId: string): void;
  /** Forget every tab's. For tests that share the app's instance. */
  reset(): void;
}

/** Why a tab's queue is held: the send gate, or an agent switch waiting on
 *  its `/remember` turn. */
export type QueueHoldReason = "gate" | "switch";

const PENDING = "pending:";

/** A strip item whose add has not been confirmed yet. */
const isPendingQueueId = (id: string | null | undefined): id is string =>
  !!id && id.startsWith(PENDING);

const RESTART_FAILED =
  "The agent could not be restarted. Check its runtime (Node/npx) and try again.";

/** A new session's title, from its first message: the words, without the
 *  `@ctx:` tokens of an ask (else the first context's label). */
function firstTitle(content: string, mentions: readonly MentionData[]): string {
  const words = content.includes("@ctx:")
    ? content
        .replace(/@ctx:\S+/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : content;
  const text = words || mentions.find((m) => m.kind === "agent_context")?.displayName || content;
  return text.slice(0, 40) + (text.length > 40 ? "..." : "");
}

export function createSessionSend(deps: SessionSendDeps): SessionSend {
  let pendingSeq = 0;
  /** Pending markers removed from the strip before Rust confirmed them: when
   *  the add lands, it is taken back out. */
  const withdrawn = new Set<string>();
  /** Why each tab's queue is held. */
  const holdReasons = new Map<string, Set<QueueHoldReason>>();
  /** The last pause state told to Rust, per tab, as `session:paused`. */
  const pushedPause = new Map<string, string>();

  const nextMarker = () => `${PENDING}${++pendingSeq}`;

  function state(tabId: string): SendState {
    const chat = deps.chat();
    const session = chat.sessions[tabId];
    return sendStateOf(session, {
      queued: chat.queues[tabId]?.length ?? 0,
      ...deps.ambient(session),
      switchPending: holdReasons.get(tabId)?.has("switch") ?? false,
    });
  }

  // ── The queue ─────────────────────────────────────────────────────────────

  /** `null` while Rust has no session to hold a queue for: unbound, a resume
   *  not yet loaded, or the agent process gone. */
  function queueKey(tabId: string): SessionKey | null {
    const s = deps.chat().sessions[tabId];
    if (!s?.acpAgentId || !s.acpSessionId || s.resumePending || s.disconnected) return null;
    return { agent_id: s.acpAgentId, session_id: s.acpSessionId };
  }

  /** Bound: into Rust's queue (shown at once, confirmed by `queue_changed`).
   *  Not bound: held locally until the bind. Rust drains it when the turn ends. */
  function enqueue(tabId: string, text: string, mentions: readonly MentionData[]): void {
    const { actions } = deps.chat();
    const key = queueKey(tabId);
    if (!key) {
      actions.enqueueMessage(tabId, text, mentions);
      return;
    }
    const marker = nextMarker();
    actions.enqueueMessage(tabId, text, mentions, marker);
    void addToRust(tabId, key, inlineQueuedText(text, mentions), marker);
  }

  async function addToRust(
    tabId: string,
    key: SessionKey,
    text: string,
    marker: string,
  ): Promise<boolean> {
    try {
      const id = await deps.agents.queueAdd(key, text, deps.queuedPrompt(text));
      if (withdrawn.delete(marker)) {
        if (typeof id === "string") void deps.agents.queueRemove(key, id).catch(() => {});
        return true;
      }
      // Normally the delta has already replaced the marker; this covers a delta
      // that never came (the session's projection closed meanwhile).
      if (typeof id === "string") deps.chat().actions.setQueueItemId(tabId, marker, id);
      return true;
    } catch (err) {
      console.warn("queue add failed; keeping the prompt locally:", err);
      withdrawn.delete(marker);
      // Local: flushed into Rust at the next bind, never lost.
      deps.chat().actions.setQueueItemId(tabId, marker, null);
      return false;
    }
  }

  function removeQueued(tabId: string, index: number): void {
    const chat = deps.chat();
    const id = chat.queueIds[tabId]?.[index] ?? null;
    chat.actions.removeQueueItem(tabId, index);
    if (!id) return;
    if (isPendingQueueId(id)) {
      withdrawn.add(id);
      return;
    }
    const key = queueKey(tabId);
    if (key) void deps.agents.queueRemove(key, id).catch(() => {});
  }

  /** Rust's queue and any local items. */
  function clearQueued(tabId: string): void {
    const chat = deps.chat();
    for (const id of chat.queueIds[tabId] ?? []) if (isPendingQueueId(id)) withdrawn.add(id);
    chat.actions.clearQueue(tabId);
    const key = queueKey(tabId);
    if (key) void deps.agents.queueClear(key).catch(() => {});
  }

  /** An agent switch hands them to the agent the tab ends up on. */
  function takeQueued(tabId: string): string[] {
    const texts = [...(deps.chat().queues[tabId] ?? [])];
    if (texts.length) clearQueued(tabId);
    return texts;
  }

  /** In order, then — with `drain` — start the head if the session is idle
   *  and its queue not paused. A no-op for a tab Rust cannot hold a queue for yet. */
  async function flushLocal(tabId: string, opts: { drain: boolean }): Promise<void> {
    const key = queueKey(tabId);
    if (!key) return;
    const chat = deps.chat();
    const texts = chat.queues[tabId] ?? [];
    const ids = chat.queueIds[tabId] ?? [];
    const local: Array<{ text: string; marker: string }> = [];
    texts.forEach((text, i) => {
      if (ids[i] === null || ids[i] === undefined) {
        const marker = nextMarker();
        chat.actions.setQueueItemIdAt(tabId, i, marker);
        local.push({ text, marker });
      }
    });
    // One at a time: the queue's order is the order they were typed in.
    for (const { text, marker } of local) {
      if (!(await addToRust(tabId, key, text, marker))) return;
    }
    if (opts.drain) await deps.agents.queueDrain(key).catch(() => null);
  }

  /** While any reason holds it, Rust does not drain; the last release drains
   *  an idle session. */
  function setHold(tabId: string, reason: QueueHoldReason, on: boolean): void {
    const reasons = holdReasons.get(tabId) ?? new Set<QueueHoldReason>();
    if (on) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size === 0) holdReasons.delete(tabId);
    else holdReasons.set(tabId, reasons);
    syncPause(tabId);
  }

  /** Tell Rust the tab's current pause state, if it differs from what it was
   *  last told for this session — on every hold change and every rebind (a
   *  new session starts unpaused). */
  function syncPause(tabId: string): void {
    const key = queueKey(tabId);
    if (!key) return;
    const paused = (holdReasons.get(tabId)?.size ?? 0) > 0;
    const sig = `${key.session_id}:${paused}`;
    if (pushedPause.get(tabId) === sig) return;
    pushedPause.set(tabId, sig);
    void deps.agents.queuePause(key, paused).catch(() => {
      if (pushedPause.get(tabId) === sig) pushedPause.delete(tabId);
    });
  }

  function forget(tabId: string): void {
    holdReasons.delete(tabId);
    pushedPause.delete(tabId);
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  function restartFailed(tabId: string): void {
    deps.chat().actions.addMessage(tabId, "assistant", RESTART_FAILED);
  }

  /** Draw the user's bubble and, for a session's first message, title it. */
  function record(tabId: string, message: OutgoingMessage, heldForBind: boolean) {
    const { content, mentions, attachments } = message;
    const chat = deps.chat();
    const first = (chat.sessions[tabId]?.messages.length ?? 0) === 0;
    // The user-visible message keeps the prose as the user typed it,
    // including the shortform mention references (`@file:src/foo.rs` etc).
    // The context block goes only to the agent, not the local transcript.
    const clientMessageId = chat.actions.addMessage(
      tabId,
      "user",
      content,
      attachments,
      trustedMentionPaths(mentions),
    );
    logEvent({
      source: "chat",
      kind: "send-agent",
      summary: content.slice(0, 120),
      payload: {
        tabId,
        mentionCount: mentions.length,
        ...(heldForBind ? { heldForBind: true } : {}),
      },
    });
    if (first) chat.actions.setSessionTitle(tabId, firstTitle(content, mentions));
    return clientMessageId;
  }

  async function send(
    tabId: string,
    message: OutgoingMessage,
    opts: SendOptions = {},
  ): Promise<void> {
    const { content, mentions, attachments } = message;
    const recorded = opts.recorded === true;
    noteSessionSent(projectPathForTab(tabId));

    let decision = decide(state(tabId), { kind: "send", recorded });
    if (decision.do === "rebind") {
      if (!(await deps.rebind(tabId))) {
        restartFailed(tabId);
        return;
      }
      decision = decide(state(tabId), { kind: "send", recorded, rebound: true });
    }
    const { actions } = deps.chat();
    switch (decision.do) {
      case "queue":
        enqueue(tabId, content, mentions);
        return;
      case "keep-held":
        actions.setPendingSend(tabId, {
          content,
          mentions,
          attachments,
          clientMessageId: opts.clientMessageId,
        });
        // Not "Starting…": nothing is starting until the user says so.
        actions.updateSessionStatus(tabId, "idle");
        return;
      case "hold-first": {
        const clientMessageId = record(tabId, message, true);
        actions.updateSessionStatus(tabId, "running");
        actions.setPendingSend(tabId, { content, mentions, attachments, clientMessageId });
        // A bind that was abandoned (Stop while starting) is not re-run by
        // anything but composer focus; make sure this send has one to wait on.
        opts.kickBind?.();
        return;
      }
      case "dispatch":
        await dispatch(tabId, message, opts);
        return;
      default:
        return;
    }
  }

  async function dispatch(
    tabId: string,
    message: OutgoingMessage,
    opts: SendOptions,
  ): Promise<void> {
    const { content, mentions, attachments } = message;
    const bound = deps.chat().sessions[tabId];
    if (!bound?.acpAgentId || !bound.acpSessionId) return;
    const key: SessionKey = { agent_id: bound.acpAgentId, session_id: bound.acpSessionId };

    // The optimistic bubble's id rides with the prompt: Rust echoes it on the
    // prompt's `user_message` delta, and the reducer adopts this bubble rather
    // than drawing the prompt a second time. A held send's bubble was drawn
    // when it was held; the caller passes its id, or it is the newest one.
    let clientMessageId = opts.clientMessageId;
    if (opts.recorded && !clientMessageId) {
      const rows = bound.messages;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].role === "user") {
          clientMessageId = rows[i].clientMessageId;
          break;
        }
      }
    }
    if (!opts.recorded) clientMessageId = record(tabId, message, false);
    // Idempotent for a held send (already running while it started), and it
    // re-asserts the state if a fresh session's initial `idle` status landed
    // between the bind and this dispatch.
    deps.chat().actions.updateSessionStatus(tabId, "running");

    const wire = await deps.wirePrompt(key.session_id, content, mentions);

    // Non-blocking send: returns the instant the prompt is queued onto the
    // SessionWorker. The atlas:agents `turn_finished` delta flips status
    // back to idle + handles empty-turn placeholder via `applyAgentDelta`.
    try {
      await deps.agents.send(
        key,
        wire.prompt,
        attachments,
        wire.resourceLinks,
        wire.pastedTexts,
        clientMessageId,
      );
      logEvent({
        source: "agent",
        kind: "stream-started",
        summary: `dispatched to ${key.session_id}`,
        payload: { tabId, acpSessionId: key.session_id, mentionCount: mentions.length },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const { actions } = deps.chat();
      actions.addMessage(tabId, "assistant", `agent send error: ${msg}`);
      actions.updateSessionStatus(tabId, "error");
      logEvent({
        source: "agent",
        kind: "stream-error",
        summary: msg.slice(0, 160),
        payload: { tabId },
      });
    }
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  function stop(tabId: string, abandonBind?: () => void): void {
    const { sessions, actions } = deps.chat();
    const s = sessions[tabId];
    const decision = decide(state(tabId), { kind: "stop" });
    if (!s) return;
    switch (decision.do) {
      case "abandon-start": {
        // The CONNECT the message was waiting on may be wedged, and the next
        // send would otherwise re-enter "Starting" on the very same parked
        // backend future. Abandon this attempt, kill the plugin's connection
        // and forget the cached agent, so a following send starts a fresh
        // connect.
        const pid = pluginIdForAgent(s.agentType);
        abandonBind?.();
        deps.agents.killPlugin(pid).catch((e) => console.warn("killPlugin on Stop failed:", e));
        deps.forgetAgent(pid);
        actions.setPendingSend(tabId, undefined);
        actions.updateSessionStatus(tabId, "idle");
        return;
      }
      case "kill":
        if (!s.acpAgentId || !s.acpSessionId) return;
        // Killing drops the connection, which takes its exit-watch task with
        // it — so no `agent_disconnected` arrives to clear the flags. We asked
        // for this, so we record it ourselves, which is also what raises the
        // Restart banner.
        actions.noteAgentKilled(tabId);
        clearQueued(tabId);
        actions.clearPermissionsForSession(s.acpSessionId);
        deps.agents.kill(s.acpAgentId).catch(() => {});
        return;
      case "cancel":
        if (!s.acpAgentId || !s.acpSessionId) return;
        // Do NOT flip to idle optimistically: the backend may still be winding
        // tools down, and lying "idle" here let a new send race the still-live
        // turn (interleaved deltas; native history loss). Mark stop-requested
        // instead — the composer shows "Stopping…" and idle arrives with the
        // turn's real terminal (`turn_finished` stop_reason=cancelled), which
        // also clears the flag. Sends typed meanwhile queue exactly as they do
        // during a running turn; the backend actor also queues defensively.
        actions.setStopping(tabId, true);
        // Rust's Stop discards the session's queue itself (and says so with
        // `queue_changed`); clearing the strip now saves the round trip, takes
        // any items still held locally with it, and withdraws any add still on
        // its way to Rust — which would otherwise land after the Stop and drain.
        clearQueued(tabId);
        // Drop any permission modal that was awaiting the user's click.
        // The Rust side has already resolved the in-flight request as
        // `Cancelled` (see registry.cancel_turn); leaving the modal up
        // would let the user click Allow on a request the agent already
        // abandoned, which silently fails on the backend and confuses
        // them into thinking permission is broken.
        actions.clearPermissionsForSession(s.acpSessionId);
        deps.agents
          .cancel({ agent_id: s.acpAgentId, session_id: s.acpSessionId }, { stop: true })
          .catch(() => {});
        return;
      default:
        return;
    }
  }

  // ── Drain ─────────────────────────────────────────────────────────────────

  /** A drain edge on a bound session: hand Rust whatever the window still
   *  holds and ask it to start the head (a no-op if it already did, or is
   *  busy, or held). A session whose agent process died is respawned first —
   *  the queue survives the restart in Rust, and the turn that left it there
   *  is what the old drain re-sent through a rebind. */
  async function releaseQueue(tabId: string): Promise<void> {
    const s = deps.chat().sessions[tabId];
    if (!s?.acpSessionId) return;
    if (s.disconnected) {
      if ((deps.chat().queues[tabId]?.length ?? 0) === 0) return;
      const before = s.acpSessionId;
      if (!(await deps.rebind(tabId))) {
        restartFailed(tabId);
        return;
      }
      // Restarted onto a different session: the ids named the old one's
      // queue, so every item the strip shows becomes local and the flush
      // below hands them to the new one.
      if (deps.chat().sessions[tabId]?.acpSessionId !== before) {
        deps.chat().actions.setAllQueueItemsLocal(tabId);
      }
    }
    // While someone else holds the remote-control seat the owner's items wait
    // (R4: only the driver prompts). Rust's drain skips them too; not asking
    // keeps the window from racing a seat change. They run once the seat is
    // back — the next drain edge, or Rust's own when the seat returns.
    await flushLocal(tabId, { drain: !sendGate(state(tabId)).remoteDriver });
  }

  function watch(tabId: string, opts: Pick<SendOptions, "kickBind"> = {}) {
    let prev: SendState | null = null;
    return {
      tick(view: DrainView): void {
        // The render's session and holds, so each commit is one step; the
        // rest is read now.
        const cur: SendState = { ...state(tabId), ...view };
        const decision = decide(cur, { kind: "drain", prev });
        prev = cur;
        if (decision.do !== "drain") return;

        // The first message held while the session was starting goes out
        // ahead of the queue — it was recorded in the transcript at send
        // time, so it is dispatched without being recorded again. Anything
        // typed meanwhile is handed to the session's queue after it, parked:
        // Rust drains it when that first turn ends.
        const held: PendingSend | undefined = decision.held
          ? deps.chat().sessions[tabId]?.pendingSend
          : undefined;
        if (held) {
          deps.chat().actions.setPendingSend(tabId, undefined);
          void Promise.resolve()
            .then(() =>
              send(tabId, held, {
                recorded: true,
                clientMessageId: held.clientMessageId,
                kickBind: opts.kickBind,
              }),
            )
            .then(() => flushLocal(tabId, { drain: false }));
        } else if (decision.queue) {
          // The queue is Rust's (the turn controller drains it when a turn
          // ends); what is left here is handing it what only the window
          // knows. Deferred one microtask so the React commit completes first.
          void Promise.resolve().then(() => releaseQueue(tabId));
        }

        // The window's send gates hold the session's queue in Rust: a resume
        // still loading, a mode it could not restore, a session another
        // process is writing, the no-AI-grant lock. Re-told on every rebind:
        // a new session starts unpaused.
        setHold(tabId, "gate", sendGate(cur).holdsQueue);
      },
    };
  }

  return {
    state,
    send,
    stop,
    watch,
    enqueue,
    removeQueued,
    clearQueued,
    takeQueued,
    flushLocal,
    queueKey,
    setHold,
    forget,
    reset() {
      pendingSeq = 0;
      withdrawn.clear();
      holdReasons.clear();
      pushedPause.clear();
    },
  };
}

/** The app's instance. */
export const sessionSend = createSessionSend({
  agents,
  chat: () => useChatStore.getState(),
  ambient: (session) => ({
    heldElsewhere: isSendHeldElsewhere(session?.acpSessionId),
    grantHold: grantLocksComposer(hasNoAiGrant(), session?.agentType ?? "", false),
    remoteDriving:
      drivenElsewhere(useRcStore.getState().bySession[session?.acpSessionId ?? ""]) !== null,
  }),
  // Called through, not captured: a test that mocks one of these modules
  // narrowly need not define what its code path never reaches.
  rebind: (tabId) => rebindDisconnectedSession(tabId),
  forgetAgent: (pluginId) => resetAgent(pluginId),
  wirePrompt: (acpSessionId, content, mentions) =>
    composeWirePrompt(acpSessionId, content, mentions),
  queuedPrompt: (text) => queuedWirePrompt(text),
});
