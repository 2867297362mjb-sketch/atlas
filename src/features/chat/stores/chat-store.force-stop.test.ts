// @vitest-environment happy-dom
//
// The store half of force-stopping a wedged agent (ATL-232).
//
// A cancel the agent ignores is now resolved by the backend after a grace
// period, which unfreezes the turn. An agent that is wedged outright would
// hang the next turn too, so a second press of Stop kills the process — and
// killing drops the connection along with the exit-watch task that would have
// sent `agent_disconnected`. Nothing arrives to end the turn, so the store has
// to record it. What this pins is that it records ALL of it: a session left
// `running` under a Restart banner offers the user a Stop button for a process
// that no longer exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const ACP_SESSION = "acp-session-1";

function boundSession() {
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "claude-code");
  actions.setAcpBinding(TAB, "agent-1", ACP_SESSION, "/tmp");
  return () => useChatStore.getState().sessions[TAB];
}

describe("force-stopping a wedged agent", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  it("leaves the composer idle and the session restartable", () => {
    const session = boundSession();
    const { actions } = useChatStore.getState();

    actions.updateSessionStatus(TAB, "running");
    actions.setStopping(TAB, true);
    expect(isBusyAgentStatus(session().status)).toBe(true);

    actions.noteAgentKilled(TAB);

    expect(session().disconnected).toBe(true);
    expect(session().stopping).toBeUndefined();
    expect(session().inflightToolIds).toBeUndefined();
    expect(isBusyAgentStatus(session().status)).toBe(false);
  });

  it("keeps the transcript and the binding a restart resumes from", () => {
    const session = boundSession();
    const { actions } = useChatStore.getState();

    actions.addMessage(TAB, "user", "do the thing");
    const before = session().messages.length;
    expect(before).toBeGreaterThan(0);

    actions.noteAgentKilled(TAB);

    expect(session().messages.length).toBe(before);
    expect(session().acpSessionId).toBe(ACP_SESSION);
    expect(session().acpAgentId).toBe("agent-1");
  });

  it("is harmless for a session that is not there", () => {
    expect(() => useChatStore.getState().actions.noteAgentKilled("no-such-tab")).not.toThrow();
  });
});

describe("another tab's agent is killed under it", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null, pendingPermissions: {} });
  });

  it("a turn running in this tab ends: the tab is not left Working", () => {
    // One process serves every tab on an agent. Another tab's Stop (twice),
    // Restart, or a start that never finished kills it, and Rust now tells
    // every session on it with `agent_disconnected` (audit #74). A kill sends
    // no turn terminal first, so the notice itself must end the turn here.
    const session = boundSession();
    const { actions } = useChatStore.getState();
    actions.updateSessionStatus(TAB, "running");
    actions.applyAgentDelta({
      kind: "tool_call_upserted",
      agent_id: "agent-1",
      session_id: ACP_SESSION,
      seq: 0,
      message_id: "m-1",
      tool_call: {
        id: "t-1",
        tool_name: "Bash",
        title: null,
        kind: "execute",
        status: "running",
        arguments: {},
        result: null,
        locations: [],
      },
    } as never);

    actions.applyAgentDelta({
      kind: "agent_disconnected",
      agent_id: "agent-1",
      session_id: ACP_SESSION,
      seq: 0,
      reason: "the agent was stopped; the next message restarts it",
    } as never);

    expect(session().disconnected).toBe(true);
    expect(isBusyAgentStatus(session().status)).toBe(false);
    expect(session().inflightToolIds).toBeUndefined();
    const tool = session()
      .messages.flatMap((m) => m.toolCalls)
      .find((t) => t.id === "t-1");
    expect(tool?.status).not.toBe("running");
  });

  it("an idle tab only learns it must restart: its status is left alone", () => {
    const session = boundSession();
    const { actions } = useChatStore.getState();
    actions.applyAgentDelta({
      kind: "agent_disconnected",
      agent_id: "agent-1",
      session_id: ACP_SESSION,
      seq: 0,
      reason: "the agent was stopped; the next message restarts it",
    } as never);
    expect(session().disconnected).toBe(true);
    expect(session().status).toBe("idle");
  });
});
