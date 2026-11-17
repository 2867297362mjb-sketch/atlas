import { describe, expect, it } from "vitest";

import { resolveStacks } from "./pull-request-stacks";
import cases from "./pull-request-stacks.fixtures.json";

// The fixture table is the contract between this resolver and the agent's
// (`stacks` in `src-tauri/src/commands/session_pull_requests.rs`, whose
// tests read the same file). A new rule is a new row there, never a case
// written on one side only.

interface FixtureLink {
  /** `owner/name#number`. */
  pr: string;
  /** `null` for a link the host has not been read for. */
  head: string | null;
  base: string | null;
  /** Resolution ignores it; a row sets it to show that. */
  state?: string;
}

interface FixtureCase {
  name: string;
  links: FixtureLink[];
  stacks: { layers: string[]; depths: number[] }[];
}

describe("resolveStacks", () => {
  it.each(cases as FixtureCase[])("$name", ({ links, stacks }) => {
    const resolved = resolveStacks(links, (link) =>
      link.head === null || link.base === null
        ? null
        : {
            repository: link.pr.slice(0, link.pr.indexOf("#")),
            headBranch: link.head,
            baseBranch: link.base,
          },
    );
    expect(
      resolved.map((stack) => ({ layers: stack.layers.map((l) => l.pr), depths: stack.depths })),
    ).toEqual(stacks);
  });
});
