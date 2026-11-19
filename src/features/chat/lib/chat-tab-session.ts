/**
 * What a chat tab knows about itself outside the chat store: whether it is the
 * one on screen, and which agent session it is saved as showing.
 *
 * Both are read off the layout store. A chat panel stays mounted behind
 * whichever tab is showing (and behind a background project), so "mounted"
 * says nothing about whether anyone is looking at it; and the chat store is
 * not persisted, so the tab's own `data` is the only thing that carries its
 * conversation across a restart (`editor-state.json`).
 */
import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";

type LayoutState = ReturnType<typeof useLayoutStore.getState>;

/**
 * Whether `tabId` is the tab showing in its column, in the project on screen.
 *
 * False for a tab behind another in its column, and for every tab of a
 * background project (their panels stay mounted). True for a tab no project's
 * layout lists: nothing says it is hidden, and a panel mounted outside the
 * tab strip must still get its session.
 */
export function isChatTabShown(layout: LayoutState, tabId: string): boolean {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (tab) return layout.activeByGroup[groupOf(tab)] === tabId;
  for (const view of Object.values(layout.viewsByWs)) {
    if (view.tabs.some((t) => t.id === tabId)) return false;
  }
  return true;
}

/** The agent session a chat tab's `data` says it shows, if any. */
export function readChatTabSession(data: Record<string, unknown> | undefined): string | null {
  const id = data?.sessionId;
  return typeof id === "string" && id ? id : null;
}

/**
 * What `tabId`'s `data` says, as far as the live layout can tell:
 * the saved session id, `""` for a tab that saves none, and `null` for a tab
 * the live layout does not hold (a background project's), which can be neither
 * read nor written from here.
 */
export function savedSessionOfTab(layout: LayoutState, tabId: string): string | null {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  return readChatTabSession(tab.data) ?? "";
}

/** The session a chat tab should get back, wherever its layout is held: the
 *  live one, or a background project's committed view. */
export function restorableSessionOfTab(layout: LayoutState, tabId: string): string | null {
  const live = layout.tabs.find((t) => t.id === tabId);
  if (live) return readChatTabSession(live.data);
  for (const view of Object.values(layout.viewsByWs)) {
    const tab = view.tabs.find((t) => t.id === tabId);
    if (tab) return readChatTabSession(tab.data);
  }
  return null;
}
