// @vitest-environment happy-dom
//
// A session reopened shows what it showed live. The snapshot a reopen paints
// from carries everything a live delta does; the mapping from it dropped the
// thinking (a thought became an empty reply: audit #6) and every tool call's
// diff, locations and subagent parent (an edit reported as a diff lost its
// "+1 −1" and its changes card, and a child's calls fell back into the
// parent's stream: audit #97). The rule this pins: a message painted from a
// snapshot is the message the live stream built.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import type { ChatMessage } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { AGENT, SESSION, delta, wireMessage, wireTool } from "./agent-wire-fixtures";
import { snapshotMessageToWire } from "./snapshot-message";

const LIVE = "tab-live";
const REOPENED = "tab-reopened";
const store = () => useChatStore.getState();

const DIFF_CALL = wireTool("t-edit", {
  tool_name: "",
  title: "Edit src/foo.ts",
  kind: "edit",
  status: "completed",
  arguments: {},
  locations: [{ path: "/proj/src/foo.ts", line: 3 }] as never,
  content_blocks: [
    { type: "diff", path: "/proj/src/foo.ts", oldText: "a\n", newText: "b\n" },
  ] as never,
});
const CHILD_CALL = wireTool("t-child", {
  status: "completed",
  parent_tool_call_id: "t-launch",
});
const MESSAGES = [
  wireMessage("msg-0", { mode: "thinking", content: "", thinking: "Let me look at foo." }),
  wireMessage("msg-1", { mode: "tool", tool_calls: [DIFF_CALL, CHILD_CALL] }),
  wireMessage("msg-2", { content: "Done." }),
];

/** What a message keeps that a reader can see. */
function seen(m: ChatMessage) {
  return {
    role: m.role,
    mode: m.mode,
    content: m.content,
    thinking: m.thinking || undefined,
    toolCalls: m.toolCalls.map((tc) => ({
      id: tc.id,
      kind: tc.kind,
      status: tc.status,
      contentBlocks: tc.contentBlocks,
      locations: tc.locations,
      parentToolCallId: tc.parentToolCallId,
    })),
  };
}

describe("a reopened session", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, pendingPermissions: {}, activeSessionId: null });
    for (const tab of [LIVE, REOPENED]) store().actions.createSession(tab, "claude-code");
    store().actions.setAcpBinding(LIVE, AGENT, SESSION, "/proj");
  });

  it("shows the thinking, diffs, locations and subagent parents it showed live", () => {
    for (const m of MESSAGES)
      store().actions.applyAgentDelta(delta("message_appended", { message: m }));
    store().actions.replaceMessages(REOPENED, MESSAGES.map(snapshotMessageToWire));

    const live = store().sessions[LIVE]!.messages.map(seen);
    const reopened = store().sessions[REOPENED]!.messages.map(seen);
    expect(reopened).toEqual(live);
    expect(reopened[0]!.thinking).toBe("Let me look at foo.");
    expect(reopened[1]!.toolCalls[0]!.contentBlocks).toHaveLength(1);
  });
});
