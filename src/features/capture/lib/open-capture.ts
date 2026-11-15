import { emitWindowEvent } from "@/lib/window-events";

/** ⌘⌥C and the palette's "Open Session Capture": the project label's
 *  capture popover, which the title bar's project label opens on hearing
 *  `atlas:open-capture`. */
export function openCapture(): void {
  emitWindowEvent("atlas:open-capture");
}
