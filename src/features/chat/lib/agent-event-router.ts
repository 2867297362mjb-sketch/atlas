/**
 * The agent event router: where each event on the `atlas:agents` channel goes.
 *
 * One listener routes session deltas into the chat store (through a
 * frame-coalesced stream, see `agent-delta-batch.ts` for the policy), queues
 * permission requests, announces what a person has to know about, and resets
 * the lazy agent handle on disconnect.
 *
 * Everything it touches is passed in, so a test drives it with a fake store
 * boundary, a fake frame scheduler and a fake clock, and no Tauri. Production
 * wiring is `start-agent-events.ts`. This module imports types only: keep it
 * that way, or its tests start needing the app.
 *
 * The ORDER of the calls inside each branch is part of the behaviour (several
 * read what an earlier one wrote). Each one says why where it matters.
 */
import {
  createFrameCoalescedStream,
  type FrameScheduler,
  type StreamTimers,
} from "@/lib/frame-coalesced-stream";
import type { AgentUpdatePhase } from "@/features/agents/stores/agent-registry-store";
import type { logEvent } from "@/features/log/lib/log";
import type { notifyAgentUpdateFailed } from "@/features/notifications/lib/app-warning-notifier";
import type { PendingPermission } from "@/types/acp";
import type { AgentDelta, AgentStreamEvent } from "@/types/agents";
import { createAgentDeltaBatch } from "./agent-delta-batch";

/** How long buffered deltas may wait when no frame fires (an unfocused or
 *  hidden window; see `frame-coalesced-stream.ts`). */
export const AGENT_BACKSTOP_MS = 250;
/** Longest a batch may be held for an active scroll gesture. Bounded so a
 *  continuous fling can never starve the stream: worst case the reader sees
 *  updates land ~2-3× per second instead of per frame while flicking. */
export const SCROLL_HOLD_MAX_MS = 400;
/** How soon a batch held for a scroll gesture is tried again. */
export const SCROLL_HOLD_RETRY_MS = 100;

/** The chat store actions the router calls. Read through `deps.actions()` at
 *  each event: an action boundary, never a captured store. */
export interface AgentRouterActions {
  applyAgentBatch(batch: {
    texts: Array<{ sessionId: string; text: string }>;
    thoughts: Array<{ sessionId: string; text: string }>;
    deltas: AgentDelta[];
  }): void;
  pushPermission(req: PendingPermission): void;
  popPermission(acpSessionId: string, requestId: string): void;
  clearPermissionsForAgent(agentId: string): void;
  setAgentStartingStatus(pluginId: string, status: string | null): void;
  failPendingBinds(pluginId: string, reason?: string): void;
  noteAgentUpdated(pluginId: string, version: string): void;
}

export interface AgentEventRouterDeps {
  actions(): AgentRouterActions;
  /** The notification pipeline's entry point for a session delta. */
  notifyAgentEvent(env: AgentDelta): void;
  resolveAgentPermission(sessionId: string, requestId: string): void;
  isStaleAgentTurn(sessionId: string, turnSeq?: number): boolean;
  pluginIdForAgentId(agentId: string): string | null;
  resetAgentByAgentId(agentId: string): void;
  setAgentUpdatePhase(pluginId: string, phase: AgentUpdatePhase | null): void;
  /** The agent's display name, for the update toast and the failure notice. */
  agentLabel(pluginId: string): string;
  toastSuccess(message: string, options: { id: string }): void;
  notifyAgentUpdateFailed: typeof notifyAgentUpdateFailed;
  logEvent: typeof logEvent;
  /** True while the reader is mid-scroll; holds a drain (capped). */
  isScrollHot(): boolean;
  frames?: FrameScheduler;
  timers?: StreamTimers;
}

export interface AgentEventRouter {
  /** Route one event off the channel. */
  route(event: AgentStreamEvent): void;
  /** Drain the buffered deltas now (still respects the scroll hold). */
  flush(): void;
  /** Stop: cancel the pending drains and ignore every later event. */
  dispose(): void;
}

export function createAgentEventRouter(deps: AgentEventRouterDeps): AgentEventRouter {
  let disposed = false;

  // Mid-fling, hold the batch: applying it re-renders ChatPanel → Transcript →
  // a reconcile of every mounted row, and when that lands in a momentum-scroll
  // frame WKWebView misses tile deadlines and the viewport blanks. Deltas keep
  // buffering; they land the moment the gesture goes quiet or the hold cap
  // expires.
  const stream = createFrameCoalescedStream<AgentDelta>({
    newBatch: createAgentDeltaBatch,
    sink: (deltas) => deps.actions().applyAgentBatch({ texts: [], thoughts: [], deltas }),
    backstopMs: AGENT_BACKSTOP_MS,
    hold: { active: deps.isScrollHot, maxMs: SCROLL_HOLD_MAX_MS, retryMs: SCROLL_HOLD_RETRY_MS },
    // The batch is lost either way; the stream itself carries on (a sink that
    // escaped into the frame callback used to present as the session freezing
    // mid-turn).
    onSinkError: (error, dropped) =>
      console.error("applyAgentBatch failed; dropped", dropped.length, "deltas:", error),
    frames: deps.frames,
    timers: deps.timers,
  });

  const route = (env: AgentStreamEvent) => {
    if (disposed) return;
    const actions = deps.actions();
    // Session-less: the manager's per-plugin install/launch progress. Not a
    // delta, so it never enters the frame buffer. The label it drives is a
    // single store write per change, and every tab on that agent reads it.
    if (env.kind === "loading_status") {
      actions.setAgentStartingStatus(env.plugin_id, env.status);
      return;
    }
    // Session-less too: an installed agent was updated on a registry bump.
    // Rust waited for it to go idle before restarting it, so nothing was
    // cut off; open sessions already got `agent_disconnected` and reconnect on
    // their next send. The toast is the only place an update is announced.
    if (env.kind === "agent_update") {
      const name = deps.agentLabel(env.plugin_id);
      if (env.phase === "waiting" || env.phase === "restarting" || env.phase === "installing") {
        deps.setAgentUpdatePhase(env.plugin_id, { phase: env.phase, version: env.version });
        if (env.phase === "restarting") actions.noteAgentUpdated(env.plugin_id, env.version);
        return;
      }
      deps.setAgentUpdatePhase(env.plugin_id, null);
      if (env.phase === "ready") {
        // Same id as the marketplace's own Update toast: a manual update can
        // also be installed by the background pass, and that is one update.
        deps.toastSuccess(`${name} updated to v${env.version}`, {
          id: `agent-update:${env.plugin_id}:${env.version}`,
        });
      } else {
        deps.notifyAgentUpdateFailed({
          pluginId: env.plugin_id,
          name,
          version: env.version,
          error: env.error ?? null,
        });
      }
      return;
    }
    switch (env.kind) {
      case "permission_request": {
        // Permission requests block the agent waiting for the user: apply
        // synchronously so the modal opens on the very next tick, not the
        // next frame (which can be ~16 ms away or more if the frame is busy
        // with a flush of accumulated chunks).
        actions.pushPermission({
          agentId: env.agent_id,
          acpSessionId: env.session_id,
          requestId: env.request_id,
          toolCall: env.tool_call as PendingPermission["toolCall"],
          options: env.options as PendingPermission["options"],
        });
        deps.notifyAgentEvent(env);
        return;
      }
      case "permission_resolved":
        actions.popPermission(env.session_id, env.request_id);
        // Answered anywhere (in-app, another path, cancelled): its banner goes too.
        deps.resolveAgentPermission(env.session_id, String(env.request_id));
        return;
      case "agent_disconnected":
        // Flush whatever's buffered before tearing the agent down so we
        // don't lose a final chunk to the post-disconnect discard.
        // Forced: teardown correctness outranks the scroll-hold.
        stream.flush(true);
        deps.notifyAgentEvent(env);
        actions.clearPermissionsForAgent(env.agent_id);
        // Tabs still waiting to be bound on this agent have no session id
        // for the reducer to route by; fail them by plugin instead. Read
        // the pairing BEFORE the cache reset below forgets it.
        {
          const pluginId = deps.pluginIdForAgentId(env.agent_id);
          if (pluginId) actions.failPendingBinds(pluginId, env.reason);
        }
        // Reset the spawn cache for the plugin that actually died. The old
        // resetDefaultAgent() only ever cleared claude-code-ts, so a crashed
        // Codex adapter stayed cached-dead until app restart (H4).
        deps.resetAgentByAgentId(env.agent_id);
        // Let the reducer flag the affected session (drives the Restart
        // affordance + rebind-on-next-send).
        stream.push(env);
        deps.logEvent({
          source: "atlas",
          kind: "agent-disconnected",
          summary: "Agent process disconnected; its spawn cache was reset",
          status: "failure",
          payload: { agentId: env.agent_id, reason: env.reason },
        });
        return;
      case "turn_finished":
        // Still pass through to the chat store so session.status flips back
        // to "idle".
        stream.push(env);
        // Superseded by a newer send → the store ignores the idle flip; skip
        // the log too (the notifier checks this itself).
        if (deps.isStaleAgentTurn(env.session_id, env.turn_seq)) return;
        deps.logEvent({
          source: "atlas",
          kind: "agent-turn-finished",
          summary: `Agent turn finished (${env.stop_reason})`,
          status: env.stop_reason === "cancelled" ? "failure" : "success",
          payload: {
            agentId: env.agent_id,
            sessionId: env.session_id,
            stopReason: env.stop_reason,
          },
        });
        // The banner quotes the final message and the turn's stats, which the
        // store only holds once this delta (and the text before it) is
        // applied: drain the buffer now rather than at the next frame.
        // The pipeline skips cancelled and stale turns itself.
        stream.flush(true);
        deps.notifyAgentEvent(env);
        return;
      case "turn_failed":
        stream.push(env);
        deps.notifyAgentEvent(env);
        return;
      case "elicitation_requested":
        // The agent is blocked on the user's answer. Same as a permission
        // request: tell them (center, toast, banner) as well as render it.
        stream.push(env);
        deps.notifyAgentEvent(env);
        return;
      case "context_usage":
      case "rate_limits":
      case "retry_status":
        // Warning-tier notifications (context window, quota, retrying).
        stream.push(env);
        deps.notifyAgentEvent(env);
        return;
      default:
        // Text, thinking and live tool output included: the batch policy
        // decides how each one coalesces.
        stream.push(env);
        return;
    }
  };

  return {
    route,
    flush: () => stream.flush(),
    dispose: () => {
      disposed = true;
      stream.dispose();
    },
  };
}

/** A gap in input longer than this counts as "the user came back". */
export const IDLE_RETURN_MS = 30_000;
/** How often the keep-warm ping runs while Atlas is in front. */
export const KEEP_WARM_MS = 20_000;

export interface IdleWakeDeps {
  /** Announce the wake (`atlas:window-active` in production). */
  signalActive(): void;
  /** True when Atlas is the focused, visible window. */
  isForeground(): boolean;
  /** Keep whatever would otherwise be suspended warm (the markdown worker). */
  keepWarm(): void;
}

/**
 * Idle-while-focused cold wake. Returns a stop function.
 *
 * The focus/visibility edges in `window-focus.ts` never fire when Atlas stays
 * the focused, visible window through a long idle stretch (the user steps away
 * without switching apps or Spaces). WebKit still throttles the idle main
 * thread and the OS can reclaim JIT/worker pages, so the first interactions on
 * return are cold and recover only gradually (the "slow for ~10-15s" symptom).
 * Two mitigations:
 *   1. Fire the same warm-up on the FIRST real interaction after an idle gap
 *      so the whole pipeline (transcript virtualizer, graphs, markdown worker)
 *      warms at once instead of path-by-path as each is lazily exercised.
 *   2. While focused+visible, ping the markdown worker on an idle cadence so
 *      WebKit doesn't suspend it out from under us (a suspended worker costs
 *      a 3s watchdog → main-thread sync fallback on the first big message).
 */
export function startIdleWake(deps: IdleWakeDeps): () => void {
  let lastActivityAt = Date.now();
  const onUserActivity = () => {
    const now = Date.now();
    if (now - lastActivityAt > IDLE_RETURN_MS) deps.signalActive();
    lastActivityAt = now;
  };
  // Discrete inputs only (not pointermove) to keep this effectively free.
  window.addEventListener("pointerdown", onUserActivity, { passive: true });
  window.addEventListener("keydown", onUserActivity, { passive: true });
  window.addEventListener("wheel", onUserActivity, { passive: true });
  const keepWarm = window.setInterval(() => {
    if (deps.isForeground()) deps.keepWarm();
  }, KEEP_WARM_MS);
  return () => {
    window.removeEventListener("pointerdown", onUserActivity);
    window.removeEventListener("keydown", onUserActivity);
    window.removeEventListener("wheel", onUserActivity);
    window.clearInterval(keepWarm);
  };
}
