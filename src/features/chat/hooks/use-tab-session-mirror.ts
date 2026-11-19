import { useEffect } from "react";
import type { ChatSession } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { savedSessionOfTab } from "../lib/chat-tab-session";

/**
 * Keep the tab's saved session (`data.sessionId`, written to
 * `editor-state.json` with the rest of the tab) equal to the conversation the
 * tab shows, so a restart can put it back (`restore-tab-session.ts`).
 *
 * Only a session with a conversation is saved. A session nothing was sent to
 * has nothing to reopen, and most agents have not stored it: saving its id
 * would turn every untouched tab into a failed load at the next launch.
 *
 * Left alone while the tab is waiting for its saved session or loading one:
 * the chat session is empty then, and reading that as "no conversation" would
 * erase the very id the load is about to use.
 */
export function useTabSessionMirror(tabId: string, session: ChatSession | undefined): void {
  const saved = useLayoutStore((s) => savedSessionOfTab(s, tabId));
  const settled = !!session && !session.pendingRestore && !session.resumePending;
  const hasConversation =
    !!session && ((session.userMessageCount ?? 0) > 0 || session.messages.length > 0);
  const showing = hasConversation ? (session?.acpSessionId ?? "") : "";
  useEffect(() => {
    // `null`: the live layout does not hold the tab (a background project's).
    if (!settled || saved === null || saved === showing) return;
    useLayoutStore.getState().actions.setTabData(tabId, { sessionId: showing || undefined });
  }, [tabId, settled, saved, showing]);
}
