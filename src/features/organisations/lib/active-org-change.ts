// The one home for "the active organisation changed".
//
// Two things move the organisation under the renderer, and both end here:
//
//   - a **switch** (`switchOrg`): the user picked another organisation;
//   - the **boot reconciliation**: Rust's stored active organisation was not
//     the desktop's (it is seeded from the web and historically fell back to
//     the account's first one), `pushActiveOrgAtBoot` corrected it, and the
//     team-chat socket came back on the right one. The comms store sees that
//     as an envelope from an organisation it was not showing.
//
// What a switch does on top of this (flush and tear down the outgoing
// organisation's projects, retarget Rust, load the incoming project) stays in
// `switchOrg`: the reconciliation changes no project, so none of it applies.

import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useSpacesStore } from "@/features/spaces/stores/spaces-store";
import { ORG_SCOPED_TYPES } from "@/lib/tab-registry";

/**
 * One change of the active organisation. `from` and `to` are in one id space
 * per reason, and are only ever compared with each other: a switch knows the
 * desktop's local organisation ids (a local-only organisation has no other),
 * the reconciliation knows the server's, which is what an envelope carries.
 */
export type ActiveOrgChange =
  | { why: "switch"; from: string | null; to: string }
  | { why: "boot-reconciliation"; from: string; to: string };

/**
 * Whether this launch's boot push of the active organisation is still owed.
 *
 * Lifetime: one launch of the renderer. It starts `pending`, and settles when
 * the push is made or when a switch goes ahead first, whichever comes first;
 * nothing un-settles it. The push is fire-and-forget, so one made after a
 * switch could land after the switch's own and drag the chat socket back to
 * the organisation just left.
 */
let bootPush: "pending" | "settled" = "pending";

/**
 * The active organisation changed. Everything both reasons need, in order:
 *
 *   1. nothing at all when `from` and `to` are the same organisation;
 *   2. a switch settles the boot push: the switch pushes its own choice;
 *   3. the outgoing organisation's tabs close: the column tabs, then the
 *      destination. Their ids embed that organisation's conversation and
 *      draft ids and mean nothing in the incoming one. Which types those are
 *      is the tab registry's `scope: "organisation"`; window-scoped tabs
 *      (team chat) stay and re-point themselves;
 *   4. the Spaces metadata cache is dropped: page trees and authors are the
 *      outgoing organisation's too.
 *
 * A switch calls this BEFORE it flushes the outgoing project, so those tabs
 * are not captured on the way out. Returns whether anything was done.
 */
export function activeOrganisationChanged(change: ActiveOrgChange): boolean {
  if (change.from === change.to) return false;
  if (change.why === "switch") bootPush = "settled";

  const layout = useLayoutStore.getState();
  for (const tab of layout.tabs) {
    if (ORG_SCOPED_TYPES.has(tab.type)) layout.actions.closeTab(tab.id);
  }
  if (layout.destination && ORG_SCOPED_TYPES.has(layout.destination.type)) {
    layout.actions.closeTab(layout.destination.id);
  }
  useSpacesStore.getState().actions.clearAll();
  return true;
}

/**
 * Push the desktop's active organisation to Rust, once per launch, so the
 * auth snapshot and everything keyed off it (the chat socket's target, the
 * gateway's `atlas-org` billing header) follow the organisation on screen.
 *
 * Safe to call on every render that changes its inputs: it waits for sign-in
 * and for the active organisation to be known (the org store hydrates from
 * disk long before the credential is confirmed), pushes once, and is a no-op
 * afterwards, as it is once a switch has gone ahead. Returns whether this
 * call made the push.
 */
export function pushActiveOrgAtBoot(input: {
  signedIn: boolean;
  /** The desktop's active organisation, once the org store knows it. */
  activeOrg: { remoteId?: string } | undefined;
}): boolean {
  if (bootPush !== "pending") return false;
  if (!input.signedIn || !input.activeOrg) return false;
  bootPush = "settled";
  void invoke("auth_set_active_org", { orgId: input.activeOrg.remoteId ?? null }).catch((e) => {
    console.warn("boot org reconciliation failed:", e);
  });
  return true;
}

/** Test seam: a fresh launch. */
export function resetActiveOrgChangeForTests(): void {
  bootPush = "pending";
}
