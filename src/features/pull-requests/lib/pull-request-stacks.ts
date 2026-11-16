/**
 * Stacks of pull requests, derived from base branches: GitHub has no native
 * stacks to read. The one resolution rule, shared by the session's pull
 * request panel, the sidebar badge and the repository list. The agent's copy
 * of it is `stacks` in `src-tauri/src/commands/session_pull_requests.rs`;
 * both are held to `pull-request-stacks.fixtures.json`, which each side's
 * tests read, so neither can drift from the other.
 *
 * The rule: a pull request sits on the one whose head branch is its base
 * branch, in the same repository (compared without case; branches with it).
 * A head branch two of them share is ambiguous and links nothing, because
 * claiming a stack that may be wrong is worse than claiming none. One with
 * unknown branches links nothing. Pull requests whose bases form a cycle have
 * no bottom, so each of them, and anything sitting on them, stands alone.
 *
 * What is resolved is the caller's choice, made before calling: every
 * item passed takes part, so a caller that wants only open pull requests
 * filters first. Every item lands in exactly one stack, a lone one in a
 * stack of one; a caller that wants only real stacks keeps those of two or
 * more.
 */

/** What resolution reads of a pull request. */
export interface PullRequestStackBranches {
  /** `owner/name`; compared without case. */
  repository: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestStack<T> {
  /** Bottom first; a parent before what sits on it. */
  layers: T[];
  /** One per layer: 0 for the bottom, the parent's depth + 1 above it.
   *  Siblings share a depth. */
  depths: number[];
}

/**
 * The items as stacks, by the rule above. `branchesOf` returns `null` for an
 * item whose branches are not known. Stacks come in the order their bottoms
 * were given, siblings in the order they were given, then the members of
 * cycles.
 */
export function resolveStacks<T>(
  items: readonly T[],
  branchesOf: (item: T) => PullRequestStackBranches | null,
): PullRequestStack<T>[] {
  const branches = items.map((item) => {
    const read = branchesOf(item);
    return read && read.headBranch !== "" ? read : null;
  });
  const key = (repository: string, branch: string) => `${repository.toLowerCase()}:${branch}`;

  // Head branch → the one item with it, or `null` once a second claims it.
  const byHead = new Map<string, number | null>();
  branches.forEach((read, index) => {
    if (!read) return;
    const head = key(read.repository, read.headBranch);
    byHead.set(head, byHead.has(head) ? null : index);
  });
  const parents = branches.map((read, index) => {
    if (!read) return null;
    const parent = byHead.get(key(read.repository, read.baseBranch));
    return parent == null || parent === index ? null : parent;
  });
  const children = items.map((): number[] => []);
  parents.forEach((parent, index) => {
    if (parent !== null) children[parent]!.push(index);
  });

  const stacks: PullRequestStack<T>[] = [];
  const placed = items.map(() => false);
  parents.forEach((parent, bottom) => {
    if (parent !== null) return;
    const stack: PullRequestStack<T> = { layers: [], depths: [] };
    const pending = [{ index: bottom, depth: 0 }];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      placed[next.index] = true;
      stack.layers.push(items[next.index]!);
      stack.depths.push(next.depth);
      const above = children[next.index]!;
      for (let at = above.length - 1; at >= 0; at -= 1) {
        pending.push({ index: above[at]!, depth: next.depth + 1 });
      }
    }
    stacks.push(stack);
  });
  // Nothing reached from a bottom is on a cycle of bases, or sits on one.
  items.forEach((item, index) => {
    if (!placed[index]) stacks.push({ layers: [item], depths: [0] });
  });
  return stacks;
}
