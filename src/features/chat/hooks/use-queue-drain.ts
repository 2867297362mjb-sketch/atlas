import { useEffect, useRef, type RefObject } from "react";
import type { ChatSession } from "@/types/agent";
import type { BindControl } from "./use-agent-bind";
import type { ChatSendHandler } from "../lib/chat-panel-handlers";
import type { MentionData } from "../lib/mentions";
import { sessionSend } from "../lib/session-send";
import { CHAT_STOP_EVENT } from "../lib/switch-agent";

/** `atlas:chat-send`: send `text` as this tab's next message. `mentions` are
 *  the chips its short forms stand for (`askAgent`'s context chips); without
 *  them the text goes as typed. */
export interface ChatSendDetail {
  text?: string;
  tabId?: string;
  mentions?: MentionData[];
}

interface QueueDrainArgs {
  tabId: string;
  session: ChatSession | undefined;
  /** A session another process is writing (ADR-0001 amendment, Rule 7). */
  heldElsewhere: boolean;
  /** The no-AI-grant hold on the queue (`send-gate.ts`). */
  grantHold: boolean;
  bindControlRef: RefObject<BindControl | null>;
}

/**
 * Tell the send module what this panel shows, on every change to it. When a
 * held first message or the queue may go, and whether Rust's queue is held,
 * is `session-send.ts`'s to decide (`watch`): it keeps the last snapshot, so
 * no edge is detected here. The dependency list is what a drain reads.
 */
export function useQueueDrain({
  tabId,
  session,
  heldElsewhere,
  grantHold,
  bindControlRef,
}: QueueDrainArgs): void {
  // One watch per mounted panel: a remount starts from nothing, which is what
  // hands a tab's local items to its session when the tab comes back.
  const watchRef = useRef<{ tabId: string; drain: ReturnType<typeof sessionSend.watch> }>(null);
  if (watchRef.current?.tabId !== tabId) {
    watchRef.current = {
      tabId,
      drain: sessionSend.watch(tabId, { kickBind: () => bindControlRef.current?.kick() }),
    };
  }
  useEffect(() => {
    watchRef.current?.drain.tick({ session, heldElsewhere, grantHold });
    // Next-step chips are extracted from the agent's own `<next_steps>` block in
    // the chat-store `turn_finished` reducer — nothing to do here.
  }, [
    tabId,
    session?.status,
    session?.acpSessionId,
    session?.resumePending,
    session?.unrestoredModeId,
    session?.disconnected,
    heldElsewhere,
    grantHold,
  ]);
}

/** Window events addressed to this panel: a send from outside the composer
 *  (`atlas:chat-send`) and a stop from outside it (`CHAT_STOP_EVENT`). */
export function useChatPanelEvents(
  tabId: string,
  handleSendRef: RefObject<ChatSendHandler | null>,
  handleStopRef: RefObject<(() => void) | null>,
): void {
  // Suggestion chips (and other adaptive affordances) send as the next message.
  // This is a GLOBAL window event and every mounted ChatPanel hears it, so only
  // act when the event is addressed to THIS tab (the chip stamps its origin
  // tabId). A tabId-less event (none today) still falls through to all, matching
  // the prior behaviour.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatSendDetail>).detail;
      if (detail?.tabId != null && detail.tabId !== tabId) return;
      if (detail?.text && handleSendRef.current) {
        handleSendRef.current(detail.text, detail.mentions ?? []);
        // Heard: a sender that dispatches it cancelable (`askAgent`, into a
        // session tab that may not have mounted yet) knows it landed.
        e.preventDefault();
      }
    };
    window.addEventListener("atlas:chat-send", handler);
    return () => window.removeEventListener("atlas:chat-send", handler);
  }, [tabId]);

  // Stop this tab's turn from outside the composer — an agent switch that
  // waited on `/remember` and now switches in place (`switch-agent.ts`). Only
  // ever addressed to one tab.
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<{ tabId?: string }>).detail?.tabId !== tabId) return;
      handleStopRef.current?.();
    };
    window.addEventListener(CHAT_STOP_EVENT, handler);
    return () => window.removeEventListener(CHAT_STOP_EVENT, handler);
  }, [tabId]);
}
