// The window event that opens (or closes) a composer's model picker from
// outside it: the chat panel turns `chat.toggleModelPicker` (⌘⇧M) into one,
// addressed to its tab, and that tab's composer answers it.

import { emitWindowEvent, onWindowEvent } from "@/lib/window-events";

/** Ask the composer in `tabId` to toggle its model picker. */
export function requestModelPicker(tabId: string): void {
  emitWindowEvent("atlas:composer-open-model", { tabId });
}

/** Run `onRequest` whenever the picker of `tabId` is asked for; requests
 *  addressed to another tab are ignored. Returns the unsubscribe. */
export function onModelPickerRequest(tabId: string, onRequest: () => void): () => void {
  return onWindowEvent("atlas:composer-open-model", (detail) => {
    if (detail?.tabId !== tabId) return;
    onRequest();
  });
}
