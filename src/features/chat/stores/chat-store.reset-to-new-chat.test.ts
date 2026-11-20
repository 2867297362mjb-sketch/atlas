// @vitest-environment happy-dom
//
// A tab reset to a new chat ("New chat", a session taken by another tab, a
// failed resume) keeps nothing of the conversation it dropped: not its loading
// state, not the deltas held for its paint, not the load still on its way, and
// not the dead agent's banner state. Each of those, left behind, made the
// fresh chat look broken in its own way.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { tauri } from "@/test/tauri-fake";
import type { AgentDelta } from "@/types/agents";
import { bumpLoadToken, isLoadStale } from "../lib/load-tokens";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const OTHER = "tab-2";
const AGENT = "agent-1";
const ACP = "acp-1";

const store = () => useChatStore.getState();
const session = (tab = TAB) => store().sessions[tab]!;

const text = (sessionId: string, delta: string) =>
  ({
    kind: "text_chunk",
    agent_id: AGENT,
    session_id: sessionId,
    seq: 0,
    message_id: "m-1",
    delta,
  }) as unknown as AgentDelta;

describe("resetting a tab to a new chat", () => {
  beforeEach(() => {
    localStorage.clear();
    tauri.reset();
    useChatStore.setState({ sessions: {}, queues: {}, queueIds: {}, activeSessionId: null });
    const { actions } = store();
    actions.createSession(TAB, "claude-code");
    actions.setAcpBinding(TAB, AGENT, ACP, "/proj");
  });

  it("drops the loading state and the deltas held for its paint", () => {
    const { actions } = store();
    actions.setTranscriptLoading(TAB, true);
    actions.applyAgentDelta(text(ACP, "from the old conversation"));

    actions.clearSession(TAB);
    expect(session().transcriptLoading).toBeFalsy();

    // A later load into the tab must not be handed the old one's deltas.
    actions.setTranscriptLoading(TAB, true);
    actions.setTranscriptLoading(TAB, false);
    expect(session().messages).toEqual([]);
  });

  it("cancels a load still on its way into the tab", () => {
    const token = bumpLoadToken(TAB);
    store().actions.clearSession(TAB);
    expect(isLoadStale(TAB, token)).toBe(true);
  });

  it("cancels the load of the tab a session is taken from", () => {
    const { actions } = store();
    const token = bumpLoadToken(TAB);
    actions.createSession(OTHER, "claude-code");
    actions.setAcpBinding(OTHER, AGENT, ACP, "/proj");
    expect(isLoadStale(TAB, token)).toBe(true);
  });

  it("forgets the dead agent: no Restart banner on a fresh chat", () => {
    useChatStore.setState((s) => {
      const tab = s.sessions[TAB]!;
      tab.disconnected = true;
      tab.updatedTo = "1.2.3";
      tab.bindError = "exited with code 1";
      tab.stopping = true;
      tab.held = true;
      tab.compacting = true;
      tab.justSentMessageId = "m-0";
      tab.retryStatus = {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        lastError: "rate limited",
        receivedAt: 0,
      };
      tab.sleptMidTurn = { turnSeq: 1, sleptSecs: 60, wokeAt: 0 };
      tab.pendingElicitation = {
        agentId: AGENT,
        requestId: "r-1",
        mode: "form",
        message: "pick one",
      };
      return s;
    });

    store().actions.clearSession(TAB);

    const fresh = session();
    expect(fresh.disconnected).toBeFalsy();
    expect(fresh.updatedTo).toBeUndefined();
    expect(fresh.bindError).toBeUndefined();
    expect(fresh.stopping).toBeFalsy();
    expect(fresh.held).toBeFalsy();
    expect(fresh.compacting).toBeFalsy();
    expect(fresh.justSentMessageId).toBeUndefined();
    expect(fresh.retryStatus).toBeUndefined();
    expect(fresh.sleptMidTurn).toBeUndefined();
    expect(fresh.pendingElicitation).toBeUndefined();
  });
});
