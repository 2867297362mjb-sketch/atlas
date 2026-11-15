// @vitest-environment happy-dom
//
// The agent event router, driven through `route` / `flush` / `dispose` with a
// fake store boundary, a fake frame scheduler and a fake clock. No Tauri.
//
// What it guards cannot be seen anywhere else. An event routed to the wrong
// place, a notification raised before the delta it quotes is in the store, or
// a forced flush that goes missing all type-check and render: the symptom is a
// banner with an empty preview, a permission prompt a frame late, or the last
// words of a reply lost when an agent dies. The `calls` log below records every
// call across the boundary in order, because the order is the behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeScheduler } from "@/lib/stream-test-fakes";
import type { AgentDelta, AgentStreamEvent } from "@/types/agents";
import {
  AGENT_BACKSTOP_MS,
  createAgentEventRouter,
  IDLE_RETURN_MS,
  KEEP_WARM_MS,
  SCROLL_HOLD_MAX_MS,
  startIdleWake,
  type AgentEventRouterDeps,
} from "./agent-event-router";
import {
  AGENT,
  delta,
  messageAppended,
  SESSION,
  text,
  thinking,
  toolOutput,
  toolUpsert,
} from "./agent-wire-fixtures";

type Call = [name: string, ...args: unknown[]];

function setup(over: Partial<AgentEventRouterDeps> = {}) {
  const scheduler = createFakeScheduler();
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);
  const state = { scrollHot: false, stale: false, pluginId: "codex" as string | null };
  const actions = {
    applyAgentBatch: record("applyAgentBatch"),
    pushPermission: record("pushPermission"),
    popPermission: record("popPermission"),
    clearPermissionsForAgent: record("clearPermissionsForAgent"),
    setAgentStartingStatus: record("setAgentStartingStatus"),
    failPendingBinds: record("failPendingBinds"),
    noteAgentUpdated: record("noteAgentUpdated"),
  };
  const router = createAgentEventRouter({
    actions: () => actions,
    notifyAgentEvent: record("notifyAgentEvent"),
    resolveAgentPermission: record("resolveAgentPermission"),
    isStaleAgentTurn: () => state.stale,
    pluginIdForAgentId: () => state.pluginId,
    resetAgentByAgentId: record("resetAgentByAgentId"),
    setAgentUpdatePhase: record("setAgentUpdatePhase"),
    agentLabel: (pluginId) => `Label(${pluginId})`,
    toastSuccess: record("toastSuccess"),
    notifyAgentUpdateFailed: record("notifyAgentUpdateFailed"),
    logEvent: (entry) => void calls.push(["logEvent", entry.kind]),
    isScrollHot: () => state.scrollHot,
    frames: scheduler.frames,
    timers: scheduler.timers,
    ...over,
  });
  const names = () => calls.map((c) => c[0]);
  /** The deltas of every batch the store was handed, batch by batch. */
  const applied = () =>
    calls
      .filter((c) => c[0] === "applyAgentBatch")
      .map((c) => (c[1] as { deltas: AgentDelta[] }).deltas);
  return { scheduler, calls, names, applied, router, state, actions };
}

const turnFinished = (stop_reason = "end_turn") =>
  delta("turn_finished", { stop_reason, turn_seq: 3 });
const disconnected = delta("agent_disconnected", { reason: "exited" });
const permissionRequest = delta("permission_request", {
  request_id: "req-1",
  tool_call: { id: "t1" },
  options: [{ id: "allow" }],
});
const elicitation = delta("elicitation_requested", {
  request_id: "e1",
  mode: "form",
  message: "Which one?",
  requested_schema: {},
  url: null,
});
const contextUsage = delta("context_usage", { used: 9, size: 10, cost: 0, currency: null });
const rateLimits = delta("rate_limits", { primary: null, secondary: null, plan_type: null });
const retryStatus = delta("retry_status", {
  attempt: 1,
  max_attempts: 3,
  delay_ms: 500,
  last_error: "overloaded",
});
const turnFailed = delta("turn_failed", { error: "boom", turn_seq: 3 });

describe("session-less events", () => {
  it("loading_status writes the starting status and never enters the buffer", () => {
    const { calls, scheduler, router } = setup();
    router.route({ kind: "loading_status", plugin_id: "codex", status: "Installing…" });
    expect(calls).toEqual([["setAgentStartingStatus", "codex", "Installing…"]]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  const update = (phase: "waiting" | "restarting" | "installing" | "ready" | "failed") =>
    ({
      kind: "agent_update",
      plugin_id: "codex",
      version: "1.2.0",
      phase,
      error: phase === "failed" ? "disk full" : null,
    }) satisfies AgentStreamEvent;

  it.each(["waiting", "installing"] as const)("agent_update %s records the phase", (phase) => {
    const { calls, router } = setup();
    router.route(update(phase));
    expect(calls).toEqual([["setAgentUpdatePhase", "codex", { phase, version: "1.2.0" }]]);
  });

  it("agent_update restarting records the phase, then tells the open sessions why", () => {
    const { calls, router } = setup();
    router.route(update("restarting"));
    expect(calls).toEqual([
      ["setAgentUpdatePhase", "codex", { phase: "restarting", version: "1.2.0" }],
      ["noteAgentUpdated", "codex", "1.2.0"],
    ]);
  });

  it("agent_update ready clears the phase and toasts, under the marketplace's toast id", () => {
    const { calls, router } = setup();
    router.route(update("ready"));
    expect(calls).toEqual([
      ["setAgentUpdatePhase", "codex", null],
      ["toastSuccess", "Label(codex) updated to v1.2.0", { id: "agent-update:codex:1.2.0" }],
    ]);
  });

  it("agent_update failed clears the phase and raises the failure notice", () => {
    const { calls, router } = setup();
    router.route(update("failed"));
    expect(calls).toEqual([
      ["setAgentUpdatePhase", "codex", null],
      [
        "notifyAgentUpdateFailed",
        { pluginId: "codex", name: "Label(codex)", version: "1.2.0", error: "disk full" },
      ],
    ]);
  });

  it("no session-less event is buffered or raises an agent notification", () => {
    const { names, scheduler, router } = setup();
    for (const phase of ["waiting", "restarting", "installing", "ready", "failed"] as const) {
      router.route(update(phase));
    }
    scheduler.frame();
    expect(names()).not.toContain("applyAgentBatch");
    expect(names()).not.toContain("notifyAgentEvent");
  });
});

describe("permissions", () => {
  it("a request is queued synchronously, not on the next frame, then announced", () => {
    const { calls, scheduler, router } = setup();
    router.route(permissionRequest);
    expect(calls).toEqual([
      [
        "pushPermission",
        {
          agentId: AGENT,
          acpSessionId: SESSION,
          requestId: "req-1",
          toolCall: { id: "t1" },
          options: [{ id: "allow" }],
        },
      ],
      ["notifyAgentEvent", permissionRequest],
    ]);
    expect(scheduler.pendingFrames()).toBe(0);
  });

  it("a request does not flush what is buffered", () => {
    const { names, router } = setup();
    router.route(text("streaming"));
    router.route(permissionRequest);
    expect(names()).toEqual(["pushPermission", "notifyAgentEvent"]);
  });

  it("a resolution pops the request and clears its banner, without a notification", () => {
    const { calls, scheduler, router } = setup();
    router.route(delta("permission_resolved", { request_id: "req-1" }));
    expect(calls).toEqual([
      ["popPermission", SESSION, "req-1"],
      ["resolveAgentPermission", SESSION, "req-1"],
    ]);
    expect(scheduler.pendingFrames()).toBe(0);
  });
});

describe("buffered deltas", () => {
  const buffered: Array<[string, AgentDelta]> = [
    ["text_chunk", text("hi")],
    ["thinking_chunk", thinking("hm")],
    ["tool_call_output_chunk", toolOutput("t1", "out")],
    ["tool_call_upserted", toolUpsert("t1")],
    ["message_appended", messageAppended("m1")],
    ["status", delta("status", { status: "running", turn_seq: 1 })],
    ["plan_updated", delta("plan_updated", { plan: [] })],
    ["title_updated", delta("title_updated", { title: "T" })],
    ["usage_updated", delta("usage_updated", { usage: {} as never })],
    ["slept_mid_turn", delta("slept_mid_turn", { turn_seq: 1, slept_secs: 60 })],
    ["queue_changed", delta("queue_changed", { queue: [] })],
    ["hold_changed", delta("hold_changed", { held: true })],
  ];

  it.each(buffered)("%s reaches the store on the next frame, and nowhere else", (_kind, env) => {
    const { calls, scheduler, router } = setup();
    router.route(env);
    expect(calls).toEqual([]);
    scheduler.frame();
    expect(calls).toEqual([["applyAgentBatch", { texts: [], thoughts: [], deltas: [env] }]]);
  });

  it("a frame of deltas is one store call, in wire order", () => {
    const { applied, scheduler, router } = setup();
    router.route(messageAppended("m1"));
    router.route(text("first "));
    router.route(text("message"));
    router.route(messageAppended("m2"));
    router.route(text("second "));
    router.route(text("message"));
    scheduler.frame();
    // The `message_appended` between the two text runs breaks the run.
    expect(applied()).toEqual([
      [messageAppended("m1"), text("first message"), messageAppended("m2"), text("second message")],
    ]);
  });

  it("drains on the backstop when frames never fire (an unfocused window)", () => {
    const { applied, scheduler, router } = setup();
    router.route(text("hi"));
    scheduler.advance(AGENT_BACKSTOP_MS - 1);
    expect(applied()).toEqual([]);
    scheduler.advance(1);
    expect(applied()).toEqual([[text("hi")]]);
  });

  it("reads the store's actions at each event, not once", () => {
    const actions = vi.fn(() => setup().actions);
    const { router } = setup({ actions });
    router.route(text("a"));
    router.route(text("b"));
    expect(actions).toHaveBeenCalledTimes(2);
  });
});

describe("events that notify as well as buffer", () => {
  const notifying: Array<[string, AgentDelta]> = [
    ["turn_failed", turnFailed],
    ["elicitation_requested", elicitation],
    ["context_usage", contextUsage],
    ["rate_limits", rateLimits],
    ["retry_status", retryStatus],
  ];

  it.each(notifying)("%s notifies at once and reaches the store on the frame", (_kind, env) => {
    const { calls, scheduler, router } = setup();
    router.route(text("before"));
    router.route(env);
    // Not a forced flush: the notification does not wait for the store.
    expect(calls).toEqual([["notifyAgentEvent", env]]);
    scheduler.frame();
    expect(calls).toEqual([
      ["notifyAgentEvent", env],
      ["applyAgentBatch", { texts: [], thoughts: [], deltas: [text("before"), env] }],
    ]);
  });
});

describe("which kinds raise an agent notification", () => {
  const every: AgentDelta[] = [
    text("a"),
    thinking("a"),
    toolOutput("t1", "a"),
    toolUpsert("t1"),
    messageAppended("m1"),
    delta("status", { status: "running", turn_seq: 1 }),
    delta("plan_updated", { plan: [] }),
    delta("title_updated", { title: "T" }),
    delta("permission_resolved", { request_id: "req-1" }),
    delta("slept_mid_turn", { turn_seq: 1, slept_secs: 60 }),
    delta("compaction", { active: true }),
    delta("mode_changed", { mode_id: "plan" }),
    delta("model_changed", { model_id: "m" }),
    permissionRequest,
    disconnected,
    turnFinished(),
    turnFailed,
    elicitation,
    contextUsage,
    rateLimits,
    retryStatus,
  ];

  it("exactly these, once each", () => {
    const { calls, router } = setup();
    for (const env of every) router.route(env);
    const notified = calls
      .filter((c) => c[0] === "notifyAgentEvent")
      .map((c) => (c[1] as AgentDelta).kind);
    expect(notified).toEqual([
      "permission_request",
      "agent_disconnected",
      "turn_finished",
      "turn_failed",
      "elicitation_requested",
      "context_usage",
      "rate_limits",
      "retry_status",
    ]);
  });
});

describe("turn_finished", () => {
  it("drains the buffer, itself included, before the notification that quotes it", () => {
    const { calls, scheduler, router } = setup();
    const done = turnFinished();
    router.route(text("the final "));
    router.route(text("answer"));
    router.route(done);
    expect(calls).toEqual([
      ["logEvent", "agent-turn-finished"],
      ["applyAgentBatch", { texts: [], thoughts: [], deltas: [text("the final answer"), done] }],
      ["notifyAgentEvent", done],
    ]);
    // Nothing is left to drain a second time.
    scheduler.frame();
    scheduler.advance(AGENT_BACKSTOP_MS);
    expect(calls).toHaveLength(3);
  });

  it("forces the flush through a scroll hold", () => {
    const { names, router, state } = setup();
    state.scrollHot = true;
    router.route(turnFinished());
    expect(names()).toEqual(["logEvent", "applyAgentBatch", "notifyAgentEvent"]);
  });

  it("logs a cancelled turn as a failure and still notifies (the pipeline skips it)", () => {
    const logEvent = vi.fn();
    const { names, router } = setup({ logEvent });
    router.route(turnFinished("cancelled"));
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent-turn-finished", status: "failure" }),
    );
    expect(names()).toEqual(["applyAgentBatch", "notifyAgentEvent"]);
  });

  it("superseded by a newer send: no log, no forced flush, no notification", () => {
    const { calls, applied, scheduler, router, state } = setup();
    state.stale = true;
    const done = turnFinished();
    router.route(done);
    expect(calls).toEqual([]);
    // It still reaches the store, on the frame: the store is what ignores it.
    scheduler.frame();
    expect(applied()).toEqual([[done]]);
  });
});

describe("agent_disconnected", () => {
  it("flushes what is buffered first, then tears down in order, then buffers itself", () => {
    const { calls, applied, scheduler, router } = setup();
    router.route(text("last words"));
    router.route(disconnected);
    expect(calls).toEqual([
      ["applyAgentBatch", { texts: [], thoughts: [], deltas: [text("last words")] }],
      ["notifyAgentEvent", disconnected],
      ["clearPermissionsForAgent", AGENT],
      // The pairing is read before the cache reset forgets it.
      ["failPendingBinds", "codex", "exited"],
      ["resetAgentByAgentId", AGENT],
      ["logEvent", "agent-disconnected"],
    ]);
    scheduler.frame();
    expect(applied()).toEqual([[text("last words")], [disconnected]]);
  });

  it("forces the flush through a scroll hold", () => {
    const { names, router, state } = setup();
    state.scrollHot = true;
    router.route(text("last words"));
    router.route(disconnected);
    expect(names()[0]).toBe("applyAgentBatch");
  });

  it("fails no pending binds when the agent has no known plugin", () => {
    const { names, router, state } = setup();
    state.pluginId = null;
    router.route(disconnected);
    expect(names()).toEqual([
      "notifyAgentEvent",
      "clearPermissionsForAgent",
      "resetAgentByAgentId",
      "logEvent",
    ]);
  });
});

describe("the events that force a flush", () => {
  const forcing = new Set(["turn_finished", "agent_disconnected"]);
  const candidates: AgentDelta[] = [
    turnFinished(),
    disconnected,
    turnFailed,
    elicitation,
    contextUsage,
    rateLimits,
    retryStatus,
    permissionRequest,
    delta("permission_resolved", { request_id: "req-1" }),
    messageAppended("m1"),
    toolUpsert("t1"),
    delta("status", { status: "idle", turn_seq: 1 }),
  ];

  it.each(candidates.map((env) => [env.kind, env] as const))("%s", (kind, env) => {
    const { names, router } = setup();
    router.route(text("buffered"));
    router.route(env);
    expect(names().includes("applyAgentBatch")).toBe(forcing.has(kind));
  });
});

describe("the scroll hold", () => {
  it("holds a frame's drain mid-scroll and lands it when the gesture goes quiet", () => {
    const { applied, scheduler, router, state } = setup();
    state.scrollHot = true;
    router.route(text("a"));
    scheduler.frame();
    expect(applied()).toEqual([]);
    state.scrollHot = false;
    router.route(text("b"));
    scheduler.frame();
    expect(applied()).toEqual([[text("ab")]]);
  });

  it("is capped, so a continuous fling cannot starve the stream", () => {
    const { applied, scheduler, router, state } = setup();
    state.scrollHot = true;
    router.route(text("a"));
    scheduler.frame();
    scheduler.advance(SCROLL_HOLD_MAX_MS - 1);
    expect(applied()).toEqual([]);
    scheduler.advance(1);
    expect(applied()).toEqual([[text("a")]]);
  });

  it("a wake flush drains now, but still respects the hold", () => {
    const { applied, router, state } = setup();
    router.route(text("a"));
    state.scrollHot = true;
    router.flush();
    expect(applied()).toEqual([]);
    state.scrollHot = false;
    router.flush();
    expect(applied()).toEqual([[text("a")]]);
  });
});

describe("a store that throws", () => {
  it("drops that batch, says so, and keeps the stream running", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: AgentDelta[][] = [];
    const { scheduler, router, actions } = setup();
    actions.applyAgentBatch = ((batch: { deltas: AgentDelta[] }) => {
      if (batch.deltas.some((d) => d.kind === "thinking_chunk")) throw new Error("boom");
      seen.push(batch.deltas);
    }) as typeof actions.applyAgentBatch;
    router.route(thinking("bad"));
    expect(() => scheduler.frame()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    router.route(text("good"));
    scheduler.frame();
    expect(seen).toEqual([[text("good")]]);
    // A forced flush that throws must not take the routing down with it.
    router.route(thinking("bad"));
    expect(() => router.route(turnFinished())).not.toThrow();
    error.mockRestore();
  });
});

describe("dispose", () => {
  it("cancels the pending drains and drops what was buffered", () => {
    const { calls, scheduler, router } = setup();
    router.route(text("a"));
    router.dispose();
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
    scheduler.frame();
    scheduler.advance(AGENT_BACKSTOP_MS);
    expect(calls).toEqual([]);
  });

  it("ignores every event after it, buffered or not", () => {
    const { calls, scheduler, router } = setup();
    router.dispose();
    router.route({ kind: "loading_status", plugin_id: "codex", status: "x" });
    router.route(permissionRequest);
    router.route(text("a"));
    router.route(turnFinished());
    router.route(disconnected);
    router.flush();
    scheduler.frame();
    expect(calls).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTimers()).toBe(0);
  });
});

describe("startIdleWake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function wake(foreground = true) {
    const signalActive = vi.fn();
    const keepWarm = vi.fn();
    const state = { foreground };
    const stop = startIdleWake({ signalActive, keepWarm, isForeground: () => state.foreground });
    return { signalActive, keepWarm, state, stop };
  }
  const input = (type: string) => window.dispatchEvent(new Event(type));

  it.each(["pointerdown", "keydown", "wheel"])(
    "signals a wake on the first %s after an idle gap",
    (type) => {
      const { signalActive, stop } = wake();
      vi.advanceTimersByTime(IDLE_RETURN_MS + 1);
      input(type);
      expect(signalActive).toHaveBeenCalledTimes(1);
      // The next input is not a return from idle.
      input(type);
      expect(signalActive).toHaveBeenCalledTimes(1);
      stop();
    },
  );

  it("does not signal while input keeps arriving inside the idle gap", () => {
    const { signalActive, stop } = wake();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(IDLE_RETURN_MS);
      input("keydown");
    }
    expect(signalActive).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the worker warm on its cadence, only while Atlas is in front", () => {
    const { keepWarm, state, stop } = wake();
    vi.advanceTimersByTime(KEEP_WARM_MS * 2);
    expect(keepWarm).toHaveBeenCalledTimes(2);
    state.foreground = false;
    vi.advanceTimersByTime(KEEP_WARM_MS * 2);
    expect(keepWarm).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop removes the listeners and the interval", () => {
    const { signalActive, keepWarm, stop } = wake();
    stop();
    vi.advanceTimersByTime(IDLE_RETURN_MS * 2);
    input("pointerdown");
    input("keydown");
    input("wheel");
    expect(signalActive).not.toHaveBeenCalled();
    expect(keepWarm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
