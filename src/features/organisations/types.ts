/**
 * Organisation data model. Local-only in phase 01, but shaped as a superset of
 * the Atlas server contracts (`packages/db` `organization`/`member`/`invitation`
 * + Better Auth) so cloud sync (a separate auth branch) is a thin adapter.
 *
 * The organisation itself is generated from
 * `src-tauri/src/state/app_state.rs:Organisation`.
 */

import type { Organisation as OrganisationWire } from "@/bindings/app-state/Organisation";
import { dropNulls, type NullsDropped } from "@/lib/drop-nulls";

/** Org member roles, highest privilege first. Matches the server `Role` enum
 *  (`@atlas/contracts`). Unused in phase 01 (no members locally) — present so
 *  the member-management UI + the auth branch share one type. */
export type Role = "admin" | "product_owner" | "developer" | "member";

/**
 * An organisation as it appears in `state.json` and in the `save_app_state` /
 * `bootstrap_app_state` payloads: generated from
 * `src-tauri/src/state/app_state.rs:Organisation` (`bun run bindings:gen`),
 * so a field Rust adds, renames or retypes is a `tsc` error here.
 *
 * Its `activeWorkspaceId` is a **storage key, not a concept**: the same
 * freeze that keeps the top-level `workspaces` / `activeWorkspaceId` keys
 * (see `AppStateWire`), applied one level down. The app calls it
 * `activeProjectId`, hence the translation below.
 */
export type { OrganisationWire };

/**
 * A top-level tenant that owns a set of projects. Exactly one org is active
 * per window. Local-only until the user opts into sync per org.
 *
 * This is {@link OrganisationWire} as the stores hold it, and is derived from
 * it so a field added on the Rust side is carried through a save without
 * being listed here. Two differences: an empty value is an absent key, not
 * `null`; and the per-org last active project (the restore target on a
 * switch) is `activeProjectId`, the app's word for the frozen
 * `activeWorkspaceId`.
 *
 * Server-mapped fields: `id` (sync key), `name`, `slug` (unique + required),
 * `logo`. Local-only fields: `activeProjectId`, `syncEnabled`, `color`, and
 * `remoteId` (the server `organization.id` once linked).
 */
export type Organisation = Omit<NullsDropped<OrganisationWire>, "activeWorkspaceId"> & {
  activeProjectId?: string;
};

/** Store shape → wire shape. The only field that moves is the frozen key. */
export function toOrganisationWire(o: Organisation): OrganisationWire {
  const { activeProjectId, ...rest } = o;
  return activeProjectId === undefined ? rest : { ...rest, activeWorkspaceId: activeProjectId };
}

/** Wire shape → store shape. Inverse of {@link toOrganisationWire}. */
export function fromOrganisationWire(o: OrganisationWire): Organisation {
  const { activeWorkspaceId, ...rest } = dropNulls(o);
  return activeWorkspaceId === undefined ? rest : { ...rest, activeProjectId: activeWorkspaceId };
}

/**
 * Org member. Mirrors the server `member` row + `get-full-organization`
 * response. Unused in phase 01 — shaped for the auth branch to populate.
 */
export interface Member {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt?: string;
  user?: { id: string; name: string; email: string; image?: string };
}

/**
 * Pending/past org invitation. Mirrors the server `invitation` row. Unused in
 * phase 01 — shaped for the auth branch.
 */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role?: Role;
  status?: string;
  expiresAt?: string;
  createdAt?: string;
  inviterId?: string;
}

/**
 * Derive a URL-safe, server-compatible slug from an org name. The server
 * enforces a globally-unique slug; we generate one locally and (in phase 01)
 * disambiguate against the current local org set — the auth branch reconciles
 * against the server on link.
 */
/** A synced org: linked to a server row AND opted into sync. The server owns
 *  its name and membership; a local-only org (either flag off) is the user's. */
export function isSyncedOrg<T extends Pick<Organisation, "syncEnabled" | "remoteId">>(
  org: T,
): org is T & { syncEnabled: true; remoteId: string } {
  return !!(org.syncEnabled && org.remoteId);
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "org";
}
