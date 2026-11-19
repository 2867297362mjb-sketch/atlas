// @vitest-environment happy-dom
//
// The status backstop: a tab whose status no longer matches its session's
// reads it back from Rust and adopts it, in the one direction a read can be
// trusted each time (see `status-heal.ts`).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import type { SessionSnapshot } from "@/types/agents";
import { useChatStore } from "../stores/chat-store";
import { HEAL_SETTLE_MS, healStatus, type HealDeps } from "./status-heal";

const TAB = "tab-1";
const AGENT = "agent-1";
const ACP = "acp-1";
const NOW = 1_000_000;

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB]!;

function rust(patch: Partial<SessionSnapshot>): HealDeps {
  return {
    now: () => NOW,
    readStatus: vi.fn(async () => ({
      agent_id: AGENT,
      session_id: ACP,
      cwd: "/proj",
      plugin_id: "opencode",
      status: "idle",
      current_mode: null,
      current_model: null,
      available_modes: [],
      available_models: [],
      available_commands: [],
      config_options: [],
      prompt_image_supported: false,
      plan: [],
      messages: [],
      usage: {},
      created_at: "",
      updated_at: "",
      ...patch,
    })) as unknown as HealDeps["readStatus"],
  };
}

/** The tab as a turn left it: `status` on turn `seq`, started `ago` ms ago. */
function tab(status: "running" | "waiting" | "idle", seq: number, ago = 60_000) {
  useChatStore.setState((s) => {
    const t = s.sessions[TAB]!;
    t.status = status;
    t.currentTurnSeq = seq;
    t.turnStartedAt = status === "idle" ? null : NOW - ago;
    if (status !== "idle") t.stopping = true;
    return s;
  });
}

describe("healing a tab's status from its session's", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, pendingPermissions: {}, activeSessionId: null });
    store().actions.createSession(TAB, "claude-code");
    store().actions.setAcpBinding(TAB, AGENT, ACP, "/proj");
  });

  it("a tab still Working long after its turn ended is corrected", async () => {
    tab("running", 2);
    await healStatus(TAB, rust({ status: "idle", turn_seq: 2 }));
    expect(session().status).toBe("idle");
    expect(session().stopping).toBeUndefined();
  });

  it("a turn that has only just started is left alone", async () => {
    tab("running", 1, HEAL_SETTLE_MS - 1);
    await healStatus(TAB, rust({ status: "idle", turn_seq: 1 }));
    expect(session().status).toBe("running");
  });

  it("a read from before the tab's turn reached Rust is not believed", async () => {
    tab("running", 3);
    await healStatus(TAB, rust({ status: "idle", turn_seq: 2 }));
    expect(session().status).toBe("running");
  });

  it("a busy read of a turn the tab saw end does not bring it back", async () => {
    tab("idle", 3);
    await healStatus(TAB, rust({ status: "running", turn_seq: 3 }));
    expect(session().status).toBe("idle");
  });

  it("a turn the tab never heard start is shown", async () => {
    tab("idle", 2);
    await healStatus(TAB, rust({ status: "running", turn_seq: 3 }));
    expect(session().status).toBe("running");
    expect(session().currentTurnSeq).toBe(3);
  });

  it("a prompt waiting on the user that the tab does not show comes back", async () => {
    tab("running", 3);
    await healStatus(
      TAB,
      rust({
        status: "waiting",
        turn_seq: 3,
        pending_permissions: [
          { request_id: "r-1", tool_call: { toolCallId: "t-1" }, options: [] },
        ] as never,
      }),
    );
    expect(session().status).toBe("waiting");
    expect(store().pendingPermissions[ACP]?.map((p) => p.requestId)).toEqual(["r-1"]);
  });

  it("a backend that does not report its turn is left alone", async () => {
    tab("running", 2);
    await healStatus(TAB, rust({ status: "idle", turn_seq: undefined }));
    expect(session().status).toBe("running");
  });

  it("a tab still loading or restarting its session is not read", async () => {
    tab("running", 2);
    store().actions.setTranscriptLoading(TAB, true);
    const deps = rust({ status: "idle", turn_seq: 2 });
    await healStatus(TAB, deps);
    expect(deps.readStatus).not.toHaveBeenCalled();
  });
});
