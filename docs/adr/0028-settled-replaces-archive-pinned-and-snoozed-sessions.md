# ADR-0028: Settled replaces Archive; sessions can be pinned and snoozed

**Status:** Accepted (2026-10-24). Amends ADR-0001, whose "archived" flag and "recency, not archiving" rules now read as settled.

## Context

ADR-0001 gave every history row an archived flag. Archive was a second place: archived sessions left the sidebar and were reached through a separate History view. The sidebar was being rebuilt as one flat list of sessions across projects, and a session list that is opened dozens of times a day needs a way to drop finished work out of sight without sending it somewhere else, and without the user doing it by hand for every session.

## Decision

- **Settled is a session state, not a place.** A settled session leaves the active list and stays on the sidebar's Settled shelf, resumable. Sending to it brings it back. There is no archive and no separate History view.
- **Sessions settle by themselves.** An idle sweep settles a session after `autoSettleAfterDays` (3 by default, 0 turns it off). By default it leaves a session alone while it has a linked pull request; merging or closing that pull request can settle it. Settling by hand is the same state.
- **Archived rows became settled rows**, in one schema migration. Imported, backfilled and older synced sessions land settled where ADR-0001 says archived.
- **Pinned** sessions sit in their own section in an order the user sets, and are never auto-settled. Pinning a settled or snoozed session brings it back.
- **Snoozed** sessions are hidden until a chosen time. One wakes early when it raises its hand (a permission request, a question or a failure), and a finished turn does not wake it. A session waiting on the user cannot be snoozed.
- **Delete is the only way a session leaves history.**

`CONTEXT.md` holds the definitions; this records why they exist.

## Consequences

- The sweep runs at launch, on the real profile, without asking. A session a user meant to keep active can settle while they are away; pinning is the way to say "keep this".
- Settling clears a pin and a snooze, so the three states never combine.
- ADR-0001's revival rule carries over: new activity on a settled row brings it back.
