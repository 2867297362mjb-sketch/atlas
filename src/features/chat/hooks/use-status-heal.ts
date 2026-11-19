import { useEffect } from "react";
import { isBusyAgentStatus } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { isChatTabShown } from "../lib/chat-tab-session";
import { healStatus } from "../lib/status-heal";

/** How often a tab that says it is busy checks that its session agrees. */
export const HEAL_EVERY_MS = 30_000;

/**
 * Keep this tab's status honest (`lib/status-heal.ts`): check it against the
 * session's when the tab is shown, and every so often while it says it is
 * busy, shown or not, since a hidden tab's status is what its sidebar card
 * shows.
 */
export function useStatusHeal(tabId: string): void {
  const shown = useLayoutStore((s) => isChatTabShown(s, tabId));
  const busy = useChatStore((s) => isBusyAgentStatus(s.sessions[tabId]?.status));

  useEffect(() => {
    if (shown) void healStatus(tabId);
  }, [shown, tabId]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void healStatus(tabId), HEAL_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [busy, tabId]);
}
