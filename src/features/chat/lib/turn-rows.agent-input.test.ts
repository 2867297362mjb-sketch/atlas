// Everything in a tool call is the agent's to send: `rawInput` and `rawOutput`
// are free-form JSON, and a title, kind or status can be anything a buggy or
// unfamiliar agent writes. One unexpected shape used to throw inside the row
// projection, which only the app's root boundary caught: the whole window
// went to the crash screen, again every time the session was shown (audit
// #94, an execute call whose `command` was an argv array). The projection must
// draw whatever it is given.

import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import { projectRows } from "./turn-rows";

const OPTS = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>(["wk:t:m1"]),
};

function turn(toolCalls: unknown[]): ChatMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls,
      fileChanges: [],
      plan: null,
      timestamp: "2026-08-23T00:00:00Z",
      mode: "tool",
    } as unknown as ChatMessage,
  ];
}

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

function anyJson(next: () => number, depth = 0): unknown {
  const pick = Math.floor(next() * (depth > 2 ? 5 : 8));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return next() > 0.5;
    case 2:
      return Math.floor(next() * 1000) - 500;
    case 3:
      return ["", "ls -la", "npm test\nrm -rf x", "<b>x</b>", "a".repeat(300)][
        Math.floor(next() * 5)
      ];
    case 4:
      return undefined;
    case 5:
      return Array.from({ length: Math.floor(next() * 4) }, () => anyJson(next, depth + 1));
    default: {
      const keys = ["command", "cmd", "path", "file_path", "description", "args", "old_string"];
      const out: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(next() * 4); i++) {
        out[keys[Math.floor(next() * keys.length)]] = anyJson(next, depth + 1);
      }
      return out;
    }
  }
}

const KINDS = ["execute", "edit", "read", "search", "fetch", "think", "other", "", 7, null];
const STATUSES = ["pending", "running", "completed", "failed", "weird", null];

describe("tool calls as an agent may send them", () => {
  it("an execute call whose command is an argv array projects", () => {
    const call = {
      id: "t1",
      toolName: "",
      kind: "execute",
      status: "completed",
      arguments: { command: ["bash", "-lc", "ls"] },
      result: null,
      locations: [],
      contentBlocks: [],
    } as unknown as ToolCallDisplay;
    expect(() => projectRows(turn([call]), OPTS)).not.toThrow();
  });

  it("no shape of arguments, result, title, kind or status throws", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed);
      const call = {
        id: `t${seed}`,
        toolName: next() > 0.3 ? String(anyJson(next) ?? "") : "Bash",
        title: anyJson(next),
        kind: KINDS[Math.floor(next() * KINDS.length)],
        status: STATUSES[Math.floor(next() * STATUSES.length)],
        arguments: anyJson(next) ?? {},
        result: anyJson(next),
        locations: [],
        contentBlocks: [],
      };
      expect(() => projectRows(turn([call]), OPTS), `seed ${seed}`).not.toThrow();
    }
  });
});
