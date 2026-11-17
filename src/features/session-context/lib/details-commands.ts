// The Details card's keyboard commands, raised from the app's action map.
//
// Whether the card docks or pops over, and where the session works, is known
// only to the session's own title-bar button, so the commands are window
// events the button on screen answers (`session-details-button.tsx`).

import { emitWindowEvent } from "@/lib/window-events";

/** Show or hide the Details card of the session in the main column. */
export function toggleSessionDetails(): void {
  emitWindowEvent("atlas:toggle-session-details");
}

/** Open that session's checkout in the preferred editor. */
export function openSessionInEditor(): void {
  emitWindowEvent("atlas:open-session-in-editor");
}
