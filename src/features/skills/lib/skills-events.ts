// Lightweight app-wide signal that the skills/packs on-disk state changed
// (install, projection, adopt, delete, …). The chat reference picker listens
// for this and refetches so freshly installed skills/components appear without
// a remount. Mirrors the knowledge mention self-heal approach.

import { emitWindowEvent } from "@/lib/window-events";

function emitSkillsChanged(): void {
  if (typeof window !== "undefined") {
    emitWindowEvent("atlas:skills-changed");
  }
}

/** Wrap a mutating skills/packs promise so it fires `atlas:skills-changed` on
 *  success. Pass-through on the resolved value; never swallows rejections. */
export function afterSkillMutation<T>(p: Promise<T>): Promise<T> {
  return p.then((r) => {
    emitSkillsChanged();
    return r;
  });
}
