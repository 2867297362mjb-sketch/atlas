import { useEffect, type RefObject } from "react";
import type { ChatSession } from "@/types/agent";
import { onWindowEvent } from "@/lib/window-events";
import { useChatStore } from "../stores/chat-store";
import { sessionBind, type BindControl } from "../lib/session-bind";

export type { BindControl };

/**
 * Bind an ACP agent + session to this tab as soon as the panel mounts.
 *
 * The thin caller of `lib/session-bind.ts`, which is where a bind is carried
 * out and where its rules are argued. This decides only WHEN: while the tab
 * has a chat session and no agent session, it holds the tab's bind, starts it,
 * and lets a composer focus ask again.
 *
 * `bindControlRef` is the panel's handle on the attempt in flight (Restart,
 * Stop, a send's kick). Null whenever no bind is held (tab already bound).
 */
export function useAgentBind(
  tabId: string,
  session: ChatSession | undefined,
  bindControlRef: RefObject<BindControl | null>,
): void {
  // The agent spawn takes 1–3 s warm and up to 30 s on a cold `npx` cache,
  // so kicking it off in parallel with the user reading the empty chat
  // hides the latency. If the user hits Send before the bind lands, the
  // submit handler queues the message and the drain effect flushes
  // it once `acpSessionId` is set. Skipped when a session is already bound
  // (sidebar resume, or a tab re-mount).
  useEffect(() => {
    if (!session) return;
    if (session.acpSessionId) return;
    const bind = sessionBind.attach(tabId);
    bindControlRef.current = { retry: bind.retry, abandon: bind.abandon, kick: bind.kick };
    // Eager bind on mount.
    bind.kick();
    // Focus event acts as a retry — if the initial bind threw (e.g. the
    // agent process couldn't spawn yet because Claude Code finished
    // installing mid-session), refocusing the composer will try again.
    const offChatInputFocused = onWindowEvent("atlas:chat-input-focused", (detail) => {
      if (!detail || detail.tabId !== tabId) return;
      if (useChatStore.getState().sessions[tabId]?.acpSessionId) return;
      bind.kick();
    });
    return () => {
      bind.detach();
      bindControlRef.current = null;
      offChatInputFocused();
    };
    // `!!session` is in the dep list so the bind effect actually
    // fires after the parallel `createSession` effect (chat-panel) flips
    // `session` from null → defined. Without it, deps stay
    // `[tabId, undefined]` across both renders (acpSessionId is
    // still undefined on the newly-created session) so React skips
    // the effect, the bind never starts, and every send sits in
    // the queue forever — the exact "messages get queued on a
    // brand-new project" symptom.
    // `agentType` is in the deps so switching the tab's agent (⌥/) re-runs the
    // bind — its cleanup detaches, which drops any in-flight bind for the
    // previous agent, preventing a stale bind from clobbering the tab. This
    // matters even when acpSessionId was already undefined (switch during the
    // first bind), where acpSessionId alone wouldn't change.
  }, [tabId, !!session, session?.acpSessionId, session?.agentType]);
}
