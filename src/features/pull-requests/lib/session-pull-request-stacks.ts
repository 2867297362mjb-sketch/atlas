/**
 * A session's linked pull requests as stacks: a pull request whose base
 * branch is another linked pull request's head (in the same repository) sits
 * on it. The rule itself is `resolveStacks` in `pull-request-stacks.ts`,
 * shared with the repository list and matched by what the agent is told.
 * Pure, over `ThreadRow.pullRequests`, for the session's pull request panel,
 * the sidebar badge and its hover list.
 *
 * Unlike the repository list, closed and merged links stay in their stack: a
 * session's panel shows what it shipped too, and a merged base still explains
 * why the layer above it exists.
 */

import type { PullRequestLink } from "@/features/chat/lib/history-api";

import { resolveStacks, type PullRequestStack } from "./pull-request-stacks";

/** `owner/name#number`, case-folded: `linkKey`, restated so the badge in
 *  `session-pull-request-links.ts` can read stacks without an import cycle. */
const linkKey = (link: Pick<PullRequestLink, "repository" | "number">) =>
  `${link.repository.toLowerCase()}#${link.number}`;

export type SessionPullRequestStack = PullRequestStack<PullRequestLink>;

/** One row of a flattened list: the link, how deep it sits, and on a
 *  stack's first row the stack's size. */
export interface SessionPullRequestLine {
  link: PullRequestLink;
  depth: number;
  /** The key of the stack's base, shared by every row of one stack. */
  stackKey: string;
  /** On the base row of a stack of two or more; `null` elsewhere. */
  stack: { size: number } | null;
}

/**
 * The session's links as stacks, by the shared rule (`resolveStacks`). Two
 * choices are this caller's: closed and merged links take part (see the
 * header), and a lone link is a stack of one, because every link gets a row.
 */
export function resolveSessionPullRequestStacks(
  links: readonly PullRequestLink[],
): SessionPullRequestStack[] {
  return resolveStacks(links, (link) =>
    link.snapshot
      ? {
          repository: link.repository,
          headBranch: link.snapshot.headBranch,
          baseBranch: link.snapshot.baseBranch,
        }
      : null,
  );
}

/** The host's last activity, else when it was linked; 0 when unreadable. */
function activityMs(link: PullRequestLink): number {
  const ms = Date.parse(link.snapshot?.updatedAt ?? link.linkedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The stacks as rows: the most recently active stack first, each stack
 *  base first. */
export function sessionPullRequestLines(
  stacks: readonly SessionPullRequestStack[],
): SessionPullRequestLine[] {
  const latest = (stack: SessionPullRequestStack) => Math.max(...stack.layers.map(activityMs));
  const ordered = [...stacks].sort((a, b) => latest(b) - latest(a));
  return ordered.flatMap((stack) => {
    const stackKey = linkKey(stack.layers[0]!);
    return stack.layers.map((link, index) => ({
      link,
      depth: stack.depths[index]!,
      stackKey,
      stack: index === 0 && stack.layers.length > 1 ? { size: stack.layers.length } : null,
    }));
  });
}

/** The links as panel rows, in one call. */
export function sessionPullRequestRows(
  links: readonly PullRequestLink[],
): SessionPullRequestLine[] {
  return sessionPullRequestLines(resolveSessionPullRequestStacks(links));
}

/** The latest time the host was read for any link; `null` before any was. */
export function latestSyncedAt(links: readonly PullRequestLink[]): string | null {
  let latest: string | null = null;
  for (const link of links) {
    const at = link.snapshot?.syncedAt;
    if (at && (latest === null || at > latest)) latest = at;
  }
  return latest;
}
