// @vitest-environment happy-dom
//
// The backfill a mounted chat panel runs for a session that is ALREADY bound:
// the model picker, the slash commands and the config options, read from the
// session's snapshot when the tab has none.
//
// It is what makes up for the entry points that bind a session without
// seeding those (`lib/session-resume.test.ts` holds the table), so what it
// fills, what it leaves alone and when it asks are pinned here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useChatStore } from "../stores/chat-store";
import { saveCachedAcpModels } from "../lib/acp-models-cache";
import { useSessionBackfill } from "./use-session-backfill";

const TAB = "tab-1";
const AGENT = "agent-opencode";
const MODELS = [
  { id: "m-small", name: "Small" },
  { id: "m-large", name: "Large" },
];
const COMMANDS = [{ name: "review", description: "Review the diff" }];
const KNOBS = [{ id: "web-search", name: "Web search", type: "boolean", currentValue: false }];

const snapshot = (sessionId: string, patch: Record<string, unknown> = {}) => ({
  agent_id: AGENT,
  session_id: sessionId,
  cwd: "/proj",
  plugin_id: "opencode",
  status: "idle",
  current_mode: null,
  current_model: "m-large",
  available_modes: [],
  available_models: MODELS,
  available_commands: COMMANDS,
  config_options: KNOBS,
  prompt_image_supported: false,
  plan: [],
  messages: [],
  ...patch,
});

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB]!;
const count = () => tauri.calls("agents_snapshot_meta").length;
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const bind = (sessionId: string) =>
  act(() => store().actions.setAcpBinding(TAB, AGENT, sessionId, "/proj"));

function mountPanel() {
  return renderHook(() =>
    useSessionBackfill(
      TAB,
      useChatStore((s) => s.sessions[TAB]),
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.handleRaw({
    agents_snapshot_meta: ({ key }) => snapshot((key as { session_id: string }).session_id),
  });
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  store().actions.createSession(TAB, "opencode");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSessionBackfill", () => {
  it("asks nothing of a tab with no session", async () => {
    mountPanel();
    await flush();
    expect(count()).toBe(0);
  });

  it("fills the model picker, the commands and the config options of a bound session, once", async () => {
    bind("sess-1");
    mountPanel();
    await flush();

    expect(tauri.calls("agents_snapshot_meta")).toEqual([
      {
        cmd: "agents_snapshot_meta",
        args: { key: { agent_id: AGENT, session_id: "sess-1" } },
      },
    ]);
    expect(session().acpAvailableModels).toEqual(MODELS);
    expect(session().acpCurrentModel).toBe("m-large");
    expect(session().availableCommands).toHaveLength(1);
    expect(session().acpConfigOptions).toHaveLength(1);

    // Filled: later changes to the session ask nothing more.
    act(() => store().actions.updateSessionStatus(TAB, "running"));
    await flush();
    expect(count()).toBe(1);
  });

  it("fills a session that is bound after the panel mounted", async () => {
    mountPanel();
    await flush();
    bind("sess-1");
    await flush();
    expect(count()).toBe(1);
    expect(session().acpAvailableModels).toEqual(MODELS);
  });

  it("asks nothing when the tab already has its models", async () => {
    bind("sess-1");
    act(() => store().actions.setAcpModels(TAB, "m-small", MODELS));
    mountPanel();
    await flush();
    expect(count()).toBe(0);
  });

  it("falls back to the agent's remembered model list when the snapshot has none", async () => {
    saveCachedAcpModels("opencode", { availableModels: MODELS });
    tauri.handleRaw({
      agents_snapshot_meta: () => snapshot("sess-1", { available_models: [], current_model: null }),
    });
    bind("sess-1");
    mountPanel();
    await flush();

    // The list only: which model the session is on is the session's to say.
    expect(session().acpAvailableModels).toEqual(MODELS);
    expect(session().acpCurrentModel ?? null).toBeNull();
  });

  it("leaves the picker empty, and does not ask again, for an agent with no models at all", async () => {
    tauri.handleRaw({
      agents_snapshot_meta: () => snapshot("sess-1", { available_models: [] }),
    });
    bind("sess-1");
    mountPanel();
    await flush();
    expect(session().acpAvailableModels ?? []).toEqual([]);

    act(() => store().actions.updateSessionStatus(TAB, "running"));
    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await flush();
    expect(count()).toBe(1);
  });

  it("does not replace commands or config options a delta already delivered", async () => {
    bind("sess-1");
    act(() => {
      store().actions.setAcpAvailableCommands(TAB, [{ name: "live", description: "From a delta" }]);
      store().actions.setAcpConfigOptions(TAB, [
        { id: "live-knob", name: "Live", type: "boolean", currentValue: true },
      ]);
    });
    mountPanel();
    await flush();

    expect(session().acpAvailableModels).toEqual(MODELS);
    expect(session().availableCommands).toEqual([{ name: "live", description: "From a delta" }]);
    expect((session().acpConfigOptions as { id: string }[]).map((k) => k.id)).toEqual([
      "live-knob",
    ]);
  });

  it("drops a snapshot that answers after the tab moved to another session", async () => {
    let answerFirst!: (v: unknown) => void;
    tauri.handleRaw({
      agents_snapshot_meta: ({ key }) => {
        const id = (key as { session_id: string }).session_id;
        if (id === "sess-1") return new Promise((r) => (answerFirst = r));
        return snapshot(id, { available_models: [{ id: "m-two", name: "Two" }] });
      },
    });
    bind("sess-1");
    mountPanel();
    await flush();

    bind("sess-2");
    await flush();
    answerFirst(snapshot("sess-1"));
    await flush();
    expect(session().acpAvailableModels).toEqual([{ id: "m-two", name: "Two" }]);
  });

  it("is quiet when the snapshot cannot be read, and does not loop", async () => {
    tauri.handleRaw({ agents_snapshot_meta: () => Promise.reject({ message: "busy" }) });
    bind("sess-1");
    mountPanel();
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(count()).toBe(1);
    expect(session().acpAvailableModels ?? []).toEqual([]);
  });

  it("writes nothing after the panel unmounts", async () => {
    let answer!: (v: unknown) => void;
    tauri.handleRaw({ agents_snapshot_meta: () => new Promise((r) => (answer = r)) });
    bind("sess-1");
    const { unmount } = mountPanel();
    await flush();
    unmount();
    answer(snapshot("sess-1"));
    await flush();
    expect(session().acpAvailableModels ?? []).toEqual([]);
    expect(session().availableCommands).toBeUndefined();
  });
});
