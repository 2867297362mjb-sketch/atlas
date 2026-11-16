// The agent delta stream's coalescing policy: what one animation frame of
// wire deltas becomes before `applyAgentBatch` sees it.
//
// These rules are what keep a streamed transcript correct, and breaking one
// renders fine: text lands, just in the wrong message; tool output appears,
// just twice. Each case feeds wire-typed deltas through the real stream (fake
// frame scheduler) and asserts the batch the store would be handed.

import { describe, expect, it } from "vitest";
import { createFrameCoalescedStream } from "@/lib/frame-coalesced-stream";
import { createFakeScheduler } from "@/lib/stream-test-fakes";
import type { AgentDelta } from "@/types/agents";
import { createAgentDeltaBatch } from "./agent-delta-batch";
import {
  delta,
  messageAppended,
  OTHER_SESSION,
  text,
  thinking,
  toolOutput,
  toolUpsert,
} from "./agent-wire-fixtures";

/** Everything pushed in one frame, as the sink receives it. */
function coalesce(...deltas: AgentDelta[]): AgentDelta[] {
  const scheduler = createFakeScheduler();
  const batches: AgentDelta[][] = [];
  const stream = createFrameCoalescedStream<AgentDelta>({
    newBatch: createAgentDeltaBatch,
    sink: (items) => void batches.push(items),
    backstopMs: 250,
    frames: scheduler.frames,
    timers: scheduler.timers,
  });
  for (const d of deltas) stream.push(d);
  scheduler.frame();
  expect(batches.length).toBeLessThanOrEqual(1);
  return batches[0] ?? [];
}

const status = (s: "running" | "idle") => delta("status", { status: s, turn_seq: 1 });

describe("text and thinking runs", () => {
  const cases: Array<{ name: string; input: AgentDelta[]; expected: AgentDelta[] }> = [
    {
      name: "consecutive text chunks of one session merge into one",
      input: [text("Hel"), text("lo "), text("world")],
      expected: [text("Hello world")],
    },
    {
      name: "consecutive thinking chunks of one session merge into one",
      input: [thinking("hm"), thinking("m…")],
      expected: [thinking("hmm…")],
    },
    {
      name: "text does not merge into thinking, or thinking into text",
      input: [thinking("plan"), text("answer"), thinking("more")],
      expected: [thinking("plan"), text("answer"), thinking("more")],
    },
    {
      name: "text of two sessions does not merge",
      input: [text("a"), text("b", OTHER_SESSION), text("c")],
      expected: [text("a"), text("b", OTHER_SESSION), text("c")],
    },
    {
      name: "a tool call between two text runs breaks the run",
      input: [text("before "), text("tool"), toolUpsert("t1"), text("after "), text("tool")],
      expected: [text("before tool"), toolUpsert("t1"), text("after tool")],
    },
    {
      name: "live tool output between two text runs breaks the run",
      input: [text("a"), toolOutput("t1", "out"), text("b")],
      expected: [text("a"), toolOutput("t1", "out"), text("b")],
    },
    {
      name: "a status delta between two text runs breaks the run",
      input: [text("a"), status("running"), text("b")],
      expected: [text("a"), status("running"), text("b")],
    },
  ];
  it.each(cases)("$name", ({ input, expected }) => {
    expect(coalesce(...input)).toEqual(expected);
  });

  // The native agent emits a whole turn in one frame. When text was bucketed
  // apart from the other deltas, the `message_appended` that anchors the second
  // run landed after its text and the reply shattered into mis-ordered
  // fragments.
  it("a message_appended between two text runs breaks the run", () => {
    const batch = coalesce(
      messageAppended("m1"),
      text("first "),
      text("message"),
      messageAppended("m2"),
      text("second "),
      text("message"),
    );
    expect(batch).toEqual([
      messageAppended("m1"),
      text("first message"),
      messageAppended("m2"),
      text("second message"),
    ]);
  });

  it("a merged run keeps the first chunk's envelope", () => {
    const first = { ...text("a"), seq: 7 };
    const [merged] = coalesce(first, { ...text("b"), seq: 8 });
    expect(merged).toEqual({ ...first, delta: "ab" });
  });
});

describe("tool-call snapshots", () => {
  it("a superseding update keeps the latest state in the original position", () => {
    const batch = coalesce(
      toolUpsert("t1", { status: "pending" }),
      text("meanwhile"),
      toolUpsert("t1", { status: "running" }),
      toolUpsert("t1", { status: "completed", result: "done" }),
    );
    expect(batch).toEqual([
      toolUpsert("t1", { status: "completed", result: "done" }),
      text("meanwhile"),
    ]);
  });

  it("keeps each tool at the position it first appeared", () => {
    const batch = coalesce(
      toolUpsert("t1", { status: "pending" }),
      toolUpsert("t2", { status: "pending" }),
      toolUpsert("t1", { status: "completed" }),
    );
    expect(batch).toEqual([
      toolUpsert("t1", { status: "completed" }),
      toolUpsert("t2", { status: "pending" }),
    ]);
  });

  it("does not merge the same tool id across sessions", () => {
    const batch = coalesce(
      toolUpsert("t1", { status: "pending" }),
      toolUpsert("t1", { status: "completed" }, OTHER_SESSION),
    );
    expect(batch).toEqual([
      toolUpsert("t1", { status: "pending" }),
      toolUpsert("t1", { status: "completed" }, OTHER_SESSION),
    ]);
  });
});

describe("live tool output", () => {
  const cases: Array<{ name: string; input: AgentDelta[]; expected: AgentDelta[] }> = [
    {
      name: "chunks of one tool append into one entry",
      input: [toolOutput("t1", "line 1\n"), toolOutput("t1", "line 2\n")],
      expected: [toolOutput("t1", "line 1\nline 2\n")],
    },
    {
      name: "chunks append at the first chunk's position, across other deltas",
      input: [toolOutput("t1", "a"), text("said"), toolOutput("t1", "b")],
      expected: [toolOutput("t1", "ab"), text("said")],
    },
    {
      name: "chunks of two tools stay apart",
      input: [toolOutput("t1", "a"), toolOutput("t2", "x"), toolOutput("t1", "b")],
      expected: [toolOutput("t1", "ab"), toolOutput("t2", "x")],
    },
    {
      name: "chunks of the same tool id in two sessions stay apart",
      input: [toolOutput("t1", "a"), toolOutput("t1", "b", OTHER_SESSION)],
      expected: [toolOutput("t1", "a"), toolOutput("t1", "b", OTHER_SESSION)],
    },
    {
      // A separate chunk entry here would double-apply once a later snapshot
      // (which already contains the chunk) replaced the buffered one.
      name: "a chunk after the tool's buffered snapshot folds into its result",
      input: [toolUpsert("t1", { result: "so far " }), toolOutput("t1", "and more")],
      expected: [toolUpsert("t1", { result: "so far and more" })],
    },
    {
      name: "a chunk folds into a snapshot that has no result yet",
      input: [toolUpsert("t1", { result: null }), toolOutput("t1", "first")],
      expected: [toolUpsert("t1", { result: "first" })],
    },
    {
      name: "a later snapshot replaces the folded result wholesale: nothing applies twice",
      input: [
        toolUpsert("t1", { result: "a" }),
        toolOutput("t1", "b"),
        toolUpsert("t1", { status: "completed", result: "ab" }),
      ],
      expected: [toolUpsert("t1", { status: "completed", result: "ab" })],
    },
    {
      // They apply first and the later snapshot replaces the result wholesale.
      name: "chunks buffered before the tool's first snapshot stay their own entry",
      input: [toolOutput("t1", "a"), toolOutput("t1", "b"), toolUpsert("t1", { result: "ab" })],
      expected: [toolOutput("t1", "ab"), toolUpsert("t1", { result: "ab" })],
    },
    {
      name: "once a snapshot is buffered, later chunks fold into it, not the earlier chunk",
      input: [toolOutput("t1", "a"), toolUpsert("t1", { result: "a" }), toolOutput("t1", "b")],
      expected: [toolOutput("t1", "a"), toolUpsert("t1", { result: "ab" })],
    },
  ];
  it.each(cases)("$name", ({ input, expected }) => {
    expect(coalesce(...input)).toEqual(expected);
  });
});

describe("everything else", () => {
  it("goes through in strict wire order, unmerged", () => {
    const input = [
      status("running"),
      messageAppended("m1"),
      delta("plan_updated", { plan: [] }),
      delta("plan_updated", { plan: [] }),
      delta("title_updated", { title: "A" }),
      delta("title_updated", { title: "B" }),
      delta("turn_finished", { stop_reason: "end_turn", turn_seq: 1 }),
      status("idle"),
    ];
    expect(coalesce(...input)).toEqual(input);
  });
});

describe("across frames", () => {
  it("nothing coalesces with a batch that has already drained", () => {
    const scheduler = createFakeScheduler();
    const batches: AgentDelta[][] = [];
    const stream = createFrameCoalescedStream<AgentDelta>({
      newBatch: createAgentDeltaBatch,
      sink: (items) => void batches.push(items),
      backstopMs: 250,
      frames: scheduler.frames,
      timers: scheduler.timers,
    });
    stream.push(toolUpsert("t1", { status: "pending" }));
    stream.push(toolOutput("t2", "a"));
    stream.push(text("a"));
    scheduler.frame();
    stream.push(toolUpsert("t1", { status: "completed" }));
    stream.push(toolOutput("t2", "b"));
    stream.push(text("b"));
    scheduler.frame();
    expect(batches).toEqual([
      [toolUpsert("t1", { status: "pending" }), toolOutput("t2", "a"), text("a")],
      [toolUpsert("t1", { status: "completed" }), toolOutput("t2", "b"), text("b")],
    ]);
  });
});
