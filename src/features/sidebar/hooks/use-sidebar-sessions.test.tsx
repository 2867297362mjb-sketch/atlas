// @vitest-environment happy-dom
//
// What the session list shows, through the hook the sidebar mounts:
// `useSidebarSessions` over the real stores, a real query client and the
// shared Tauri fake standing where Rust's history does (`threads_projects`).
//
// The sorting itself is pure and pinned in `lib/sidebar-sessions.test.ts`.
// This pins what the hook adds: that a session's state in history lands it in
// the right section (ADR-0028), that the list re-reads when history says it
// changed and re-sorts when a snooze runs out, the project filter, and the
// side work the sidebar owns (the outside-session sync, the pull request
// sweep).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import type { ThreadProject, ThreadRow } from "@/features/chat/lib/history-api";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { SidebarSection } from "../lib/sidebar-sessions";
import { useSidebarStore } from "../stores/sidebar-store";
import {
  useActiveSessionId,
  useLiveSessions,
  useProjectSessions,
  useSidebarSessions,
} from "./use-sidebar-sessions";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

const ORG = "org-1";
const PROJECTS = [
  { id: "p-app", name: "app", path: "/work/app", orgId: ORG },
  { id: "p-docs", name: "docs", path: "/work/docs", orgId: ORG },
  // Another organisation's: its history group is not this sidebar's.
  { id: "p-other", name: "other", path: "/work/other", orgId: "org-2" },
];

function row(threadId: string, patch: Partial<ThreadRow> = {}): ThreadRow {
  return {
    threadId,
    sessionId: `s-${threadId}`,
    agentId: "atlas-agent",
    title: threadId,
    updatedAt: at(-60),
    createdAt: at(-120),
    settledAt: null,
    pinnedAt: null,
    pinOrder: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastSnoozeWakeAt: null,
    lastViewedAt: null,
    lastTurnCompletedAt: null,
    unread: false,
    woke: false,
    projectName: "app",
    folderPaths: ["/work/app"],
    liveElsewhere: false,
    heldWorking: false,
    branch: null,
    model: null,
    ...patch,
  } as ThreadRow;
}
const group = (path: string, threads: ThreadRow[]): ThreadProject => ({
  name: path,
  paths: [path],
  isCurrent: false,
  threads,
});

/** History, as Rust would answer `threads_projects` right now. */
let history: ThreadProject[] = [];
const count = (cmd: string) => tauri.calls(cmd).length;

const flush = () => act(() => vi.advanceTimersByTimeAsync(1));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
let client: QueryClient;

async function mountSidebar() {
  const view = renderHook(() => useSidebarSessions(), { wrapper });
  await flush();
  const sections = () => {
    const p = view.result.current.partition;
    const ids = (section: SidebarSection) => p[section].map((s) => s.threadId);
    return {
      pinned: ids("pinned"),
      active: ids("active"),
      snoozed: ids("snoozed"),
      settled: ids("settled"),
    };
  };
  const find = (threadId: string) => {
    const p = view.result.current.partition;
    return [...p.pinned, ...p.active, ...p.snoozed, ...p.settled].find(
      (s) => s.threadId === threadId,
    );
  };
  return { ...view, sections, find };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  tauri.reset();
  history = [];
  tauri.handleRaw({
    threads_projects: () => history,
    threads_sync_project: () => 0,
    session_pull_requests_sync: () => ({}),
  });
  localStorage.clear();
  client = new QueryClient();
  useOrgStore.setState({ activeOrganisationId: ORG });
  useProjectStore.setState({ projects: PROJECTS, activeProjectId: "p-app" });
  useAppStore.setState({ currentProject: { path: "/work/app", name: "app" } as never });
  useSidebarStore.setState({ scopeProjectId: null });
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, sidebarSort: "recent" } }));
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useLayoutStore.setState({ activeTabId: null });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

describe("where a session's state lands it", () => {
  // One row per state a session can be in, each in the project "app" unless
  // it says otherwise. `expected` is the whole list, top to bottom.
  const STATES: ThreadRow[] = [
    row("active-old", { updatedAt: at(-300) }),
    row("active-new", { updatedAt: at(-5) }),
    // Unread and woken are Rust's verdicts, carried on the row: they change
    // how a row is drawn, not where it sits.
    row("unread", { updatedAt: at(-30), unread: true }),
    row("woke", { updatedAt: at(-20), woke: true, lastSnoozeWakeAt: at(-20) }),
    // Pinned: the user's order (the fractional key), whatever the recency.
    row("pin-second", { pinnedAt: at(-10), pinOrder: "a1", updatedAt: at(-1) }),
    row("pin-first", { pinnedAt: at(-500), pinOrder: "a0", updatedAt: at(-900) }),
    row("pin-keyless", { pinnedAt: at(-50), updatedAt: at(-2) }),
    // Snoozed: only while the wake time is still ahead.
    row("snoozed-later", { snoozedUntil: at(120), snoozedAt: at(-10) }),
    row("snoozed-soon", { snoozedUntil: at(10), snoozedAt: at(-90) }),
    row("snooze-over", { snoozedUntil: at(-1), snoozedAt: at(-90), updatedAt: at(-90) }),
    // Settled: the shelf, most recently settled first.
    row("settled-old", { settledAt: at(-2000) }),
    row("settled-new", { settledAt: at(-100) }),
    // Nothing to open yet.
    row("draft", { sessionId: null }),
  ];

  it("sorts every state into its section, in its order", async () => {
    history = [
      group("/work/app", STATES),
      group("/work/other", [row("another-org")]),
      group("/tmp/scratch", [row("never-opened-here")]),
    ];
    const sidebar = await mountSidebar();

    expect(sidebar.sections()).toEqual({
      pinned: ["pin-first", "pin-second", "pin-keyless"],
      active: ["active-new", "woke", "unread", "snooze-over", "active-old"],
      snoozed: ["snoozed-soon", "snoozed-later"],
      settled: ["settled-new", "settled-old"],
    });
    expect(sidebar.find("unread")?.unread).toBe(true);
    expect(sidebar.find("woke")?.woke).toBe(true);
    // A snooze that is over is not a snooze: the row carries no wake time.
    expect(sidebar.find("snooze-over")?.snoozedUntil).toBeNull();
    expect(sidebar.find("snoozed-soon")?.snoozedUntil).toBe(at(10));
    expect(sidebar.result.current.isLoading).toBe(false);
    expect(sidebar.result.current.error).toBeNull();
  });

  it.each([
    // Pinning a snoozed or settled session clears the other state in Rust
    // (ADR-0028), so these pairs should not reach the list. If one does, this
    // is the precedence it gets: snoozed, then settled, then pinned.
    ["pinned and snoozed", { pinnedAt: at(-5), snoozedUntil: at(30) }, "snoozed"],
    ["pinned and settled", { pinnedAt: at(-5), settledAt: at(-1) }, "settled"],
    ["snoozed and settled", { snoozedUntil: at(30), settledAt: at(-1) }, "snoozed"],
  ] as const)("as found: %s lands in %s", async (_name, patch, section) => {
    history = [group("/work/app", [row("both", patch)])];
    const sidebar = await mountSidebar();
    expect(sidebar.sections()[section]).toEqual(["both"]);
  });

  it("orders the active list by start time when the setting asks", async () => {
    history = [
      group("/work/app", [
        row("started-first", { createdAt: at(-500), updatedAt: at(-1) }),
        row("started-last", { createdAt: at(-10), updatedAt: at(-400) }),
      ]),
    ];
    const sidebar = await mountSidebar();
    expect(sidebar.sections().active).toEqual(["started-first", "started-last"]);

    act(() =>
      useSettingsStore.setState((s) => ({ settings: { ...s.settings, sidebarSort: "created" } })),
    );
    expect(sidebar.sections().active).toEqual(["started-last", "started-first"]);
  });

  it("reports a history store that will not open, without asking again", async () => {
    tauri.handleRaw({ threads_projects: () => Promise.reject(new Error("history is locked")) });
    const sidebar = await mountSidebar();
    expect(sidebar.result.current.error).toBe("history is locked");
    expect(sidebar.sections()).toEqual({ pinned: [], active: [], snoozed: [], settled: [] });

    await advance(10 * MINUTE);
    expect(count("threads_projects")).toBe(1);
  });
});

describe("snoozed sessions", () => {
  it("come back by the clock when the wake time passes, without a re-read", async () => {
    history = [
      group("/work/app", [
        row("soon", { snoozedUntil: at(10), updatedAt: at(-200) }),
        row("later", { snoozedUntil: at(30), updatedAt: at(-300) }),
        row("working", { updatedAt: at(-1) }),
      ]),
    ];
    const sidebar = await mountSidebar();
    expect(sidebar.sections().snoozed).toEqual(["soon", "later"]);

    await advance(10 * MINUTE - 1);
    expect(sidebar.sections().snoozed).toEqual(["soon", "later"]);

    // The timer is the wake time plus 50 ms of slack.
    await advance(1 + 50);
    expect(sidebar.sections()).toMatchObject({
      active: ["working", "soon"],
      snoozed: ["later"],
    });

    // And it re-arms for the next one.
    await advance(20 * MINUTE);
    expect(sidebar.sections()).toMatchObject({
      active: ["working", "soon", "later"],
      snoozed: [],
    });
    expect(count("threads_projects")).toBe(1);
  });

  it("one that raises its hand wakes early: Rust says so and the list re-reads", async () => {
    const snoozed = row("asked", { snoozedUntil: at(240), snoozedAt: at(-5) });
    history = [group("/work/app", [snoozed, row("other", { updatedAt: at(-1) })])];
    const sidebar = await mountSidebar();
    expect(sidebar.sections()).toMatchObject({ active: ["other"], snoozed: ["asked"] });

    // A permission request in the snoozed session: Rust ends the snooze,
    // marks the row woken and announces the change.
    history = [
      group("/work/app", [
        { ...snoozed, snoozedUntil: null, woke: true, lastSnoozeWakeAt: at(0), updatedAt: at(0) },
        row("other", { updatedAt: at(-1) }),
      ]),
    ];
    await act(() => tauri.emit("atlas:threads-changed"));
    await flush();

    expect(sidebar.sections()).toMatchObject({ active: ["asked", "other"], snoozed: [] });
    expect(sidebar.find("asked")?.woke).toBe(true);
    expect(count("threads_projects")).toBe(2);
  });

  it("stay snoozed through a finished turn: recency alone does not wake one", async () => {
    const snoozed = row("quiet", { snoozedUntil: at(240) });
    history = [group("/work/app", [snoozed])];
    const sidebar = await mountSidebar();

    history = [group("/work/app", [{ ...snoozed, updatedAt: at(0), lastTurnCompletedAt: at(0) }])];
    await act(() => tauri.emit("atlas:threads-changed"));
    await flush();
    expect(sidebar.sections()).toMatchObject({ active: [], snoozed: ["quiet"] });
  });
});

describe("the project filter", () => {
  beforeEach(() => {
    history = [
      group("/work/app", [
        row("in-app", { updatedAt: at(-1) }),
        row("app-settled", { settledAt: at(-5) }),
        row("app-with-docs", {
          updatedAt: at(-2),
          attachedProjects: [{ path: "/work/docs", displayName: "docs" }],
        } as Partial<ThreadRow>),
      ]),
      group("/work/docs", [
        row("in-docs", { updatedAt: at(-3), folderPaths: ["/work/docs"] }),
        row("docs-pinned", { pinnedAt: at(-9), pinOrder: "a0", folderPaths: ["/work/docs"] }),
      ]),
    ];
  });

  it("lists every project of the organisation when nothing is picked", async () => {
    const sidebar = await mountSidebar();
    expect(sidebar.result.current.scopeProjectId).toBeNull();
    expect(sidebar.result.current.projects.map((p) => p.id)).toEqual(["p-app", "p-docs"]);
    expect(sidebar.sections()).toEqual({
      pinned: ["docs-pinned"],
      active: ["in-app", "app-with-docs", "in-docs"],
      snoozed: [],
      settled: ["app-settled"],
    });
  });

  it("narrows every section to the picked project, plus sessions that have it attached", async () => {
    const sidebar = await mountSidebar();
    act(() => useSidebarStore.getState().actions.setScopeProjectId("p-docs"));

    expect(sidebar.result.current.scopeProjectId).toBe("p-docs");
    expect(sidebar.sections()).toEqual({
      pinned: ["docs-pinned"],
      active: ["app-with-docs", "in-docs"],
      snoozed: [],
      settled: [],
    });
    // Listed because the project is attached to it, and it says so.
    expect(sidebar.find("app-with-docs")?.viaAttached).toBe(true);
    expect(sidebar.find("in-docs")?.viaAttached).toBe(false);
    // The filter is a view of what was read, not another read.
    expect(count("threads_projects")).toBe(1);
  });

  it("falls back to every project when the remembered one is gone", async () => {
    useSidebarStore.setState({ scopeProjectId: "p-deleted" });
    const sidebar = await mountSidebar();
    expect(sidebar.result.current.scopeProjectId).toBeNull();
    expect(sidebar.sections().active).toEqual(["in-app", "app-with-docs", "in-docs"]);
  });

  it("follows the organisation: another one's projects bring their own sessions", async () => {
    history = [
      ...history,
      group("/work/other", [row("in-other", { folderPaths: ["/work/other"] })]),
    ];
    const sidebar = await mountSidebar();
    expect(sidebar.find("in-other")).toBeUndefined();

    act(() => useOrgStore.setState({ activeOrganisationId: "org-2" }));
    expect(sidebar.result.current.projects.map((p) => p.id)).toEqual(["p-other"]);
    expect(sidebar.sections()).toEqual({
      pinned: [],
      active: ["in-other"],
      snoozed: [],
      settled: [],
    });
  });

  it("useProjectSessions lists one project the same way, and nothing without one", async () => {
    const one = renderHook(({ id }) => useProjectSessions(id), {
      wrapper,
      initialProps: { id: "p-docs" as string | null },
    });
    await flush();
    expect(one.result.current.partition.pinned.map((s) => s.threadId)).toEqual(["docs-pinned"]);
    expect(one.result.current.partition.active.map((s) => s.threadId)).toEqual([
      "app-with-docs",
      "in-docs",
    ]);

    one.rerender({ id: null });
    expect(one.result.current.partition.active).toEqual([]);
  });
});

describe("keeping the list current", () => {
  it("re-reads when history changes and when the window is focused, and at no other time", async () => {
    history = [group("/work/app", [row("one")])];
    const sidebar = await mountSidebar();
    expect(count("threads_projects")).toBe(1);

    history = [group("/work/app", [row("one"), row("two", { updatedAt: at(0) })])];
    await advance(10 * MINUTE);
    // Nothing polls.
    expect(count("threads_projects")).toBe(1);
    expect(sidebar.sections().active).toEqual(["one"]);

    await act(() => tauri.emit("atlas:threads-changed"));
    await flush();
    expect(sidebar.sections().active).toEqual(["two", "one"]);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(count("threads_projects")).toBe(3);
  });

  it("stops listening when the sidebar unmounts", async () => {
    const sidebar = await mountSidebar();
    expect(tauri.listenerCount("atlas:threads-changed")).toBe(1);
    sidebar.unmount();
    await flush();
    expect(tauri.listenerCount("atlas:threads-changed")).toBe(0);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(10 * MINUTE);
    expect(count("threads_projects")).toBe(1);
    expect(count("threads_sync_project")).toBe(1);
    expect(count("session_pull_requests_sync")).toBe(0);
  });

  it("asks the agents for sessions started outside Atlas: on open, on a project change, on focus", async () => {
    await mountSidebar();
    expect(tauri.calls("threads_sync_project").map((c) => c.args.cwd)).toEqual(["/work/app"]);

    act(() =>
      useAppStore.setState({ currentProject: { path: "/work/docs", name: "docs" } as never }),
    );
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(tauri.calls("threads_sync_project").map((c) => c.args.cwd)).toEqual([
      "/work/app",
      "/work/docs",
      "/work/docs",
    ]);
  });
});

describe("the pull request sweep", () => {
  const sweeps = () =>
    tauri.calls("session_pull_requests_sync").map((c) => ({
      threadIds: c.args.threadIds,
      force: c.args.force,
    }));

  beforeEach(() => {
    history = [
      group("/work/app", [
        row("active", { updatedAt: at(-1) }),
        row("pinned", { pinnedAt: at(-9), pinOrder: "a0" }),
        row("snoozed", { snoozedUntil: at(600) }),
        row("settled", { settledAt: at(-5) }),
      ]),
    ];
  });

  it("covers every listed session that is not settled: 1.5 s after mount, then every minute", async () => {
    await mountSidebar();
    await advance(1_498);
    expect(sweeps()).toEqual([]);
    await advance(2);
    expect(sweeps()).toEqual([{ threadIds: ["pinned", "active", "snoozed"], force: false }]);

    await advance(60_000);
    expect(sweeps()).toHaveLength(2);
  });

  it("runs at once on focus, and not at all while the window is hidden", async () => {
    await mountSidebar();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(sweeps()).toHaveLength(1);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await advance(5 * 60_000);
    expect(sweeps()).toHaveLength(1);
    visibility.mockRestore();
  });

  it("forces one session's when its turn ends", async () => {
    await mountSidebar();
    const { actions } = useChatStore.getState();
    act(() => {
      actions.createSession("tab-1", "atlas-agent");
      actions.setAcpBinding("tab-1", "agent-1", "s-active", "/work/app");
      actions.updateSessionStatus("tab-1", "running");
    });
    expect(sweeps()).toEqual([]);

    act(() => actions.updateSessionStatus("tab-1", "idle"));
    expect(sweeps()).toEqual([{ threadIds: ["active"], force: true }]);
  });
});

describe("what a live tab is doing", () => {
  const live = () => renderHook(() => useLiveSessions());
  const open = (tabId: string, sessionId: string, status: string) => {
    const { actions } = useChatStore.getState();
    actions.createSession(tabId, "atlas-agent");
    actions.setAcpBinding(tabId, "agent-1", sessionId, "/work/app");
    actions.updateSessionStatus(tabId, status as never);
  };

  it("names running, waiting on the user and failed sessions, and leaves idle ones out", () => {
    open("tab-run", "s-run", "running");
    open("tab-wait", "s-wait", "waiting");
    open("tab-err", "s-err", "error");
    open("tab-idle", "s-idle", "idle");
    useChatStore.getState().actions.createSession("tab-unbound", "atlas-agent");

    expect(Object.fromEntries(live().result.current)).toEqual({
      "s-run": { status: "running", tabId: "tab-run" },
      "s-wait": { status: "waiting", tabId: "tab-wait" },
      "s-err": { status: "error", tabId: "tab-err" },
    });
  });

  it("is the same map through a streaming turn, and a new one when a status changes", () => {
    open("tab-run", "s-run", "running");
    const { result } = live();
    const before = result.current;

    act(() => {
      useChatStore.getState().actions.addMessage("tab-run", "assistant", "chunk");
    });
    expect(result.current).toBe(before);

    act(() => useChatStore.getState().actions.updateSessionStatus("tab-run", "waiting"));
    expect(result.current).not.toBe(before);
    expect(result.current.get("s-run")?.status).toBe("waiting");
  });

  it("useActiveSessionId is the active tab's session, when it has one", () => {
    open("tab-run", "s-run", "running");
    const { result } = renderHook(() => useActiveSessionId());
    expect(result.current).toBeNull();

    act(() => useLayoutStore.setState({ activeTabId: "tab-run" }));
    expect(result.current).toBe("s-run");
    act(() => useLayoutStore.setState({ activeTabId: "some-terminal" }));
    expect(result.current).toBeNull();
  });
});
