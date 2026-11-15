/**
 * The global agent event bus, started once at app scope. Production wiring for
 * `agent-event-router.ts`: it hands the router its real dependencies, subscribes
 * it to `atlas:agents`, and starts what has to run alongside it (focus
 * tracking, the idle wake, notification housekeeping).
 *
 * Returns a stop function that undoes all of it, so a React StrictMode
 * double-mount leaves one live listener, not two.
 */
import { initAnimationVisibility } from "@tryatlas/design/session";
import { toast } from "sonner";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { setAgentUpdatePhase } from "@/features/agents/stores/agent-registry-store";
import { logEvent } from "@/features/log/lib/log";
import {
  isStaleAgentTurn,
  notifyAgentEvent,
  resolveAgentPermission,
} from "@/features/notifications/lib/agent-notifier";
import { notifyAgentUpdateFailed } from "@/features/notifications/lib/app-warning-notifier";
import { initSourceOpenedClearing } from "@/features/notifications/lib/source-opened";
import { initDockBadgeClearing } from "@/lib/dock-badge";
import { warmMarkdownWorker } from "@/lib/markdown-cache";
import { primeNativeNotificationPermission } from "@/lib/native-notify";
import { isScrollHot } from "@/lib/scroll-hot";
import { initWindowFocusTracking, isWindowFocused } from "@/lib/window-focus";
import { useChatStore } from "../stores/chat-store";
import { createAgentEventRouter, startIdleWake } from "./agent-event-router";
import { listenAgents, pluginIdForAgentId, resetAgentByAgentId } from "./agents-api";
import { pruneContextUsageCache } from "./context-usage-cache";
import { emitWindowEvent, onWindowEvent } from "@/lib/window-events";

export function startAgentEvents(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  // Native window focus + the "cold wake" signal live in `src/lib/window-focus.ts`:
  // the terminal notifier needs the same answer this did.
  const stopFocusTracking = initWindowFocusTracking();
  const stopAnimationVisibility = initAnimationVisibility();
  const stopBadgeClearing = initDockBadgeClearing();
  // Opening a session/terminal/conversation clears its stale banners + unread items.
  const stopSourceOpened = initSourceOpenedClearing();

  const stopIdleWake = startIdleWake({
    signalActive: () => emitWindowEvent("atlas:window-active"),
    isForeground: () => isWindowFocused() && document.visibilityState === "visible",
    keepWarm: warmMarkdownWorker,
  });

  // Housekeeping, well off the startup critical path: sweep stale
  // per-session context-usage gauges out of localStorage (they had no
  // other removal path and grew one key per session forever).
  const pruneTimer = window.setTimeout(() => pruneContextUsageCache(), 15_000);

  // Establish notification permission EAGERLY at startup (see native-notify.ts
  // for why lazy asking lost the first real background notification).
  void primeNativeNotificationPermission();

  const router = createAgentEventRouter({
    actions: () => useChatStore.getState().actions,
    notifyAgentEvent,
    resolveAgentPermission,
    isStaleAgentTurn,
    pluginIdForAgentId,
    resetAgentByAgentId,
    setAgentUpdatePhase,
    agentLabel: (pluginId) => agentMeta(pluginId).label,
    toastSuccess: (message, options) => void toast.success(message, options),
    notifyAgentUpdateFailed,
    logEvent,
    isScrollHot,
  });

  // When the webview is hidden/throttled, requestAnimationFrame is paused, so
  // buffered deltas (incl. a turn's terminal + the next turn's "running") sit
  // unapplied until the next frame. Flush immediately on wake so status
  // ordering is applied promptly and a stale "done" can't visibly linger.
  // (The stream's own backstop timer covers a reader watching an unfocused
  // window, where there is no wake edge to hear.)
  const flushOnWake = () => router.flush();
  const offWindowActive = onWindowEvent("atlas:window-active", flushOnWake);

  void listenAgents(router.route).then((un) => {
    if (cancelled) un();
    else unlisten = un;
  });

  // Agent spawn is deferred until the user first focuses the message input
  // (see `MessageInput`'s focus handler). `npx -y @zed-industries/claude-code-acp`
  // can take 10–30s on a cold npm cache; doing it at app boot adds visible
  // latency to first paint and races the project-rehydration cascade. The
  // user is unlikely to send a prompt within the first few hundred ms of
  // focusing the composer, so the spawn finishes in the background while
  // they type.

  return () => {
    cancelled = true;
    router.dispose();
    offWindowActive();
    stopFocusTracking();
    stopAnimationVisibility();
    stopBadgeClearing();
    stopSourceOpened();
    stopIdleWake();
    window.clearTimeout(pruneTimer);
    unlisten?.();
  };
}
