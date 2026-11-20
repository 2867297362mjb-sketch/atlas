// @vitest-environment happy-dom
//
// One agent session, one tab. Every delta goes to the first tab holding a
// session, so a second holder never heard from it again: its status stayed
// wherever it was, and the sidebar, which reads any holder, showed "Working"
// for a turn that had finished in the other tab. Binding a session now takes
// it from whichever tab had it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { tauri } from "@/test/tauri-fake";
import type { AgentDelta } from "@/types/agents";
import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "./chat-store";

const OLD_TAB = "tab-old";
const NEW_TAB = "tab-new";
const AGENT = "agent-1";
const ACP = "acp-1";

const store = () => useChatStore.getState();
const holders = () =>
  Object.entries(store().sessions)
    .filter(([, s]) => s.acpSessionId === ACP)
    .map(([id]) => id);

const status = (value: "running" | "idle", turnSeq: number) =>
  ({
    kind: "status",
    agent_id: AGENT,
    session_id: ACP,
    seq: 0,
    status: value,
    turn_seq: turnSeq,
  }) as unknown as AgentDelta;

describe("binding a session another tab holds", () => {
  beforeEach(() => {
    localStorage.clear();
    tauri.reset();
    useChatStore.setState({ sessions: {}, queues: {}, queueIds: {}, activeSessionId: null });
    const { actions } = store();
    actions.createSession(OLD_TAB, "claude-code");
    actions.setAcpBinding(OLD_TAB, AGENT, ACP, "/proj");
    actions.addMessage(OLD_TAB, "user", "hi");
    actions.applyAgentDelta(status("running", 1));
    actions.createSession(NEW_TAB, "claude-code");
  });

  it("takes it: the session has one tab, and the old one is a new chat", () => {
    store().actions.setAcpBinding(NEW_TAB, AGENT, ACP, "/proj");

    expect(holders()).toEqual([NEW_TAB]);
    const old = store().sessions[OLD_TAB];
    expect(old.acpSessionId).toBeUndefined();
    expect(old.status).toBe("idle");
    expect(old.messages).toEqual([]);
  });

  it("leaves the agent session open: it is the new tab's now", () => {
    store().actions.setAcpBinding(NEW_TAB, AGENT, ACP, "/proj");

    expect(tauri.calls("agents_drop_session")).toEqual([]);
  });

  it("a turn ending in the new tab leaves no tab still working", () => {
    const { actions } = store();
    actions.setAcpBinding(NEW_TAB, AGENT, ACP, "/proj");
    actions.applyAgentDelta(status("running", 1));
    actions.applyAgentDelta(status("idle", 1));

    const busy = Object.values(store().sessions).filter((s) => isBusyAgentStatus(s.status));
    expect(busy).toEqual([]);
  });

  it("rebinding the same tab to its own session changes nothing else", () => {
    store().actions.setAcpBinding(OLD_TAB, AGENT, ACP, "/proj");

    expect(holders()).toEqual([OLD_TAB]);
    expect(store().sessions[OLD_TAB].messages).toHaveLength(1);
  });
});
