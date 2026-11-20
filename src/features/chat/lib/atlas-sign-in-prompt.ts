// The native agent's "you're signed out of Atlas" offer.
//
// Atlas Agent runs on the Atlas gateway, so signed out it has no model list
// and cannot start. That is not a failure — nothing is broken and there is no
// cause for "Fix with agent" to chase — so it is said as a plain notice with
// the one action that fixes it, never as an error toast. Callers only raise it
// when the user asked for something (a send, a manual refresh); an automatic
// start says nothing.

import { toast } from "sonner";
import { useAuthStore } from "@/features/auth/stores/auth-store";

/** One id, so a burst of refused sends (several tabs, a retry) shows one
 *  notice rather than a stack of them. */
const TOAST_ID = "atlas-agent-signed-out";

export function promptAtlasSignIn(): void {
  toast("Sign in to Atlas to use Atlas Agent", {
    id: TOAST_ID,
    action: {
      label: "Sign in",
      onClick: () => void useAuthStore.getState().actions.beginSignIn(),
    },
  });
}
