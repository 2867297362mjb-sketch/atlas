// @vitest-environment happy-dom
//
// The composer's mode pill healing itself: a bound session whose modes never
// reached the store is seeded from its snapshot, and a pill left "loading" by
// a start that hung is settled by a 120 s backstop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useChatStore } from "../stores/chat-store";
import { useComposerModesSelfHeal } from "./use-composer-modes-self-heal";

/** How long a pending pill may spin before it is settled regardless. */
const BACKSTOP_MS = 120_000;

const TAB = "tab-1";
const AGENT = "agent-opencode";
const MODES = [
  { id: "read-only", name: "Read only" },
  { id: "auto", name: "Auto" },
];

const snapshot = (patch: Record<string, unknown> = {}) => ({
  agent_id: AGENT,
  session_id: "sess-1",
  cwd: "/proj",
  plugin_id: "opencode",
  status: "idle",
  current_mode: "auto",
  current_model: null,
  available_modes: MODES,
  available_models: [],
  available_commands: [],
  prompt_image_supported: false,
  plan: [],
  messages: [],
  ...patch,
});

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB]!;
const count = () => tauri.calls("agents_snapshot_meta").length;
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const bind = () => act(() => store().actions.setAcpBinding(TAB, AGENT, "sess-1", "/proj"));
const mountComposer = () => renderHook(() => useComposerModesSelfHeal(TAB));

function newTab(agentType: string) {
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  store().actions.createSession(TAB, agentType);
}

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.handleRaw({ agents_snapshot_meta: () => snapshot() });
  localStorage.clear();
  newTab("opencode");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("seeding modes the bind path missed", () => {
  it("seeds a bound session that has none, from its snapshot, once", async () => {
    bind();
    mountComposer();
    await flush();

    expect(tauri.calls("agents_snapshot_meta")[0]!.args).toEqual({
      key: { agent_id: AGENT, session_id: "sess-1" },
    });
    expect(session().acpAvailableModes).toEqual(MODES);
    expect(session().acpCurrentMode).toBe("auto");
    // Seeding the modes is also what ends the pill's loading state.
    expect(session().acpModesPending).toBe(false);

    act(() => store().actions.updateSessionStatus(TAB, "running"));
    await flush();
    expect(count()).toBe(1);
  });

  it("waits for the binding", async () => {
    mountComposer();
    await flush();
    expect(count()).toBe(0);
    bind();
    await flush();
    expect(count()).toBe(1);
  });

  it("asks nothing when the modes are already there", async () => {
    bind();
    act(() => store().actions.setAcpModes(TAB, "auto", MODES, "opencode"));
    mountComposer();
    await flush();
    expect(count()).toBe(0);
  });

  it("never asks for a Claude session: its pill is its own permission modes", async () => {
    newTab("claude-code");
    bind();
    mountComposer();
    await flush();
    expect(count()).toBe(0);
  });

  it("drops a snapshot that came from another agent's session", async () => {
    // The tab was relabelled but still holds the old binding: the snapshot is
    // tagged with the agent it came from, and a mismatch is stale.
    tauri.handleRaw({ agents_snapshot_meta: () => snapshot({ plugin_id: "kilo" }) });
    bind();
    mountComposer();
    await flush();
    expect(session().acpAvailableModes ?? []).toEqual([]);
  });

  it("leaves the picker alone when the agent advertises no modes, or cannot be read", async () => {
    tauri.handleRaw({ agents_snapshot_meta: () => snapshot({ available_modes: [] }) });
    bind();
    const first = mountComposer();
    await flush();
    expect(session().acpAvailableModes ?? []).toEqual([]);
    first.unmount();

    tauri.handleRaw({ agents_snapshot_meta: () => Promise.reject({ message: "busy" }) });
    mountComposer();
    await advance(60_000);
    expect(session().acpAvailableModes ?? []).toEqual([]);
    // One ask per mount: a failure is not retried on a timer.
    expect(count()).toBe(2);
  });

  it("writes nothing after the composer unmounts", async () => {
    let answer!: (v: unknown) => void;
    tauri.handleRaw({ agents_snapshot_meta: () => new Promise((r) => (answer = r)) });
    bind();
    const { unmount } = mountComposer();
    await flush();
    unmount();
    answer(snapshot());
    await flush();
    expect(session().acpAvailableModes ?? []).toEqual([]);
  });
});

describe("a pill left loading", () => {
  it("is settled after 120 s, not before", async () => {
    // An unbound non-Claude tab starts with the pill loading.
    expect(session().acpModesPending).toBe(true);
    mountComposer();

    await advance(BACKSTOP_MS - 1);
    expect(session().acpModesPending).toBe(true);
    await advance(1);
    expect(session().acpModesPending).toBe(false);
  });

  it("restarts its clock when the pill goes back to loading", async () => {
    mountComposer();
    await advance(BACKSTOP_MS - 1);
    // The start finished by itself, then the agent was switched.
    act(() => store().actions.setAcpModesPending(TAB, false));
    act(() => store().actions.setAcpModesPending(TAB, true));

    await advance(BACKSTOP_MS - 1);
    expect(session().acpModesPending).toBe(true);
    await advance(1);
    expect(session().acpModesPending).toBe(false);
  });

  it("is not touched once the composer is gone", async () => {
    const { unmount } = mountComposer();
    unmount();
    await advance(2 * BACKSTOP_MS);
    expect(session().acpModesPending).toBe(true);
  });
});
