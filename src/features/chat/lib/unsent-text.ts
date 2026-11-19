/**
 * What the user sent to a chat tab that has not reached an agent yet, and how
 * it outlives the tab being reset.
 *
 * A message sent to a tab whose session is still starting or loading waits on
 * the tab: the first one held for the bind (`ChatSession.pendingSend`), the
 * rest in its queue. A load that fails resets the tab to a new chat, and a
 * reset drops both, so a message the user had already sent vanished, with only
 * a toast about something else to show for it. It goes back into the composer
 * instead: the conversation it was written for is not there, so the user
 * decides whether it goes to the new chat, somewhere else, or nowhere.
 */
import { emitWindowEvent } from "@/lib/window-events";
import { useChatStore } from "../stores/chat-store";
import type { ChatInsertDetail } from "./response-selection";

/** `tabId`'s unsent messages, oldest first. */
export function unsentTextOf(tabId: string): string[] {
  const { sessions, queues } = useChatStore.getState();
  const held = sessions[tabId]?.pendingSend?.content;
  return [...(held ? [held] : []), ...(queues[tabId] ?? [])].filter((text) => text.trim());
}

/** Write `text` after the session's draft: into its composer when mounted,
 *  else into the stored draft its composer reads on mount. */
export function draftInto(tabId: string, text: string): void {
  const detail: ChatInsertDetail = { text, tabId, append: true };
  const heard = !emitWindowEvent("atlas:chat-insert", detail, { cancelable: true });
  if (heard) return;
  const chat = useChatStore.getState();
  const cur = chat.drafts[tabId] ?? "";
  chat.actions.setDraft(tabId, cur.trim() ? `${cur}\n\n${text}` : text);
}

/** Reset `tabId` to a new chat, with its unsent messages back in its
 *  composer. True when there were any. */
export function clearKeepingUnsent(tabId: string): boolean {
  const unsent = unsentTextOf(tabId);
  useChatStore.getState().actions.clearSession(tabId);
  if (unsent.length === 0) return false;
  draftInto(tabId, unsent.join("\n\n"));
  return true;
}
