// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// What each of the channel's three listeners does with each kind of frame,
// seen from outside: the presence store, the board's reads and the detail
// cache, and the comments the hook returns. Frames are emitted on the real
// channel through the Tauri fake.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {}, dismiss: () => {} }),
}));
vi.mock("@/features/organisations/lib/use-org-directory", () => ({
  useOrgDirectory: () => ({ members: [], byId: new Map(), currentUserId: "u_me" }),
}));
vi.mock("./watch-queue", () => ({ queueFollow: async () => {}, queueUnfollow: async () => {} }));
const listComments = vi.hoisted(() => vi.fn());
vi.mock("./comments-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./comments-api")>();
  return { ...real, comments: { ...real.comments, list: listComments } };
});

import type { SessionDetail } from "../types";
import type { Comment } from "./comments-api";

const { ARTIFACTS_EVENT } = await import("./cloud-event");
const { readCachedDetail, writeCachedDetail, clearDetailCache } = await import("./detail-cache");
const { startTeamPresenceListener } = await import("./team-presence");
const { useTeamPresenceStore } = await import("../stores/team-presence-store");
const { useSessionComments } = await import("./use-session-comments");
const { useTimelineBoard } = await import("./use-timeline-board");

/** A frame as Rust would emit it, and everything it set off. */
const frame = (payload: unknown) =>
  act(async () => void (await tauri.emit(ARTIFACTS_EVENT, payload)));

function comment(sessionId: string, id: string): Comment {
  return {
    id,
    sessionId,
    anchorKind: "message",
    anchorId: "row-1",
    parentId: null,
    authorId: "user_ada",
    guestName: null,
    body: id,
    mentions: [],
    createdAt: "2026-09-20T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedBy: null,
  } as Comment;
}

/** Frames no listener may act on: unknown to this build, or malformed. */
const REFUSED: Array<[string, unknown]> = [
  ["an unknown kind", { kind: "sessionArchived", sessionId: "ses_a" }],
  ["a malformed entryUpsert", { kind: "entryUpsert", session_id: "ses_a" }],
  ["a malformed commentUpsert", { kind: "commentUpsert", sessionId: "ses_a" }],
  ["a malformed presence", { kind: "presence", projectId: "ws_1" }],
  ["a malformed revoked", { kind: "revoked" }],
  ["no payload", null],
];

beforeEach(() => {
  tauri.reset();
  listComments.mockReset();
  listComments.mockResolvedValue({ byAnchor: {}, session: [] });
  clearDetailCache();
  useTeamPresenceStore.getState().actions.reset();
});

describe("presence roster", () => {
  const roster = () => useTeamPresenceStore.getState().byProject;

  /** Listening, with two Projects' rosters already heard. */
  async function listening(): Promise<() => void> {
    const stop = startTeamPresenceListener();
    await frame({ kind: "presence", projectId: "ws_1", online: ["u_ada"] });
    await frame({ kind: "presence", projectId: "ws_2", online: ["u_grace"] });
    return stop;
  }

  it("presence replaces that Project's roster", async () => {
    const stop = await listening();

    await frame({ kind: "presence", projectId: "ws_1", online: ["u_ada", "u_linus"] });

    expect(roster()).toEqual({ ws_1: ["u_ada", "u_linus"], ws_2: ["u_grace"] });
    stop();
  });

  it("revoked forgets that Project", async () => {
    const stop = await listening();

    await frame({ kind: "revoked", projectId: "ws_1" });

    expect(roster()).toEqual({ ws_2: ["u_grace"] });
    stop();
  });

  // The named difference: the board and the comments re-read on a resync,
  // and presence cannot, because nothing reads a roster. See `cloud-event.ts`.
  it("resync keeps the rosters it has: there is nothing to re-read them from", async () => {
    const stop = await listening();
    const before = roster();

    await frame({ kind: "resync" });

    expect(roster()).toBe(before);
    expect(tauri.calls()).toEqual([]);
    stop();
  });

  it.each([
    ["boardChanged", { kind: "boardChanged" }],
    ["entryUpsert", { kind: "entryUpsert", sessionId: "ses_a", change: "updated", entry: {} }],
    [
      "commentUpsert",
      { kind: "commentUpsert", sessionId: "ses_a", comment: comment("ses_a", "c") },
    ],
    ...REFUSED,
  ])("%s changes nothing", async (_name, payload) => {
    const stop = await listening();
    const before = roster();

    await frame(payload);

    expect(roster()).toBe(before);
    stop();
  });

  it("hears nothing once stopped", async () => {
    const stop = await listening();
    stop();
    await act(async () => {});

    await frame({ kind: "presence", projectId: "ws_3", online: ["u_linus"] });

    expect(roster()).toEqual({ ws_1: ["u_ada"], ws_2: ["u_grace"] });
  });
});

describe("Timeline board", () => {
  const A = { sessionId: "ses_a", projectPath: "/p" };
  const B = { sessionId: "ses_b", projectPath: "/p" };
  const reads = () => tauri.calls("artifacts_board").length;
  const cached = () => [A, B].filter((ref) => readCachedDetail(ref)).map((ref) => ref.sessionId);

  /** The board mounted and settled, with two Sessions' details cached. */
  async function mounted() {
    tauri.handleRaw({
      artifacts_board: () => ({ sessions: [], cloudPending: false, cloudFailed: false }),
    });
    const props = {
      open: null,
      projectPaths: ["/p"],
      projectsKey: "/p",
      projectFilter: null,
      activeOrganisationId: "org_1",
      openSession: () => {},
      setProjectFilter: () => {},
    };
    const hook = renderHook(() => useTimelineBoard(props));
    await act(async () => {});
    writeCachedDetail(A, {} as SessionDetail);
    writeCachedDetail(B, {} as SessionDetail);
    return { hook, readsAtMount: reads() };
  }

  it("boardChanged re-reads the board and keeps the cached details", async () => {
    const { readsAtMount } = await mounted();

    await frame({ kind: "boardChanged" });

    expect(reads()).toBe(readsAtMount + 1);
    expect(cached()).toEqual(["ses_a", "ses_b"]);
  });

  it("entryUpsert forgets that Session's cached detail and reads nothing", async () => {
    const { readsAtMount } = await mounted();

    await frame({ kind: "entryUpsert", sessionId: "ses_a", change: "updated", entry: {} });

    expect(cached()).toEqual(["ses_b"]);
    expect(reads()).toBe(readsAtMount);
  });

  it("resync forgets every cached detail and re-reads the board", async () => {
    const { readsAtMount } = await mounted();

    await frame({ kind: "resync" });

    expect(cached()).toEqual([]);
    expect(reads()).toBe(readsAtMount + 1);
  });

  it.each([
    [
      "commentUpsert",
      { kind: "commentUpsert", sessionId: "ses_a", comment: comment("ses_a", "c") },
    ],
    ["presence", { kind: "presence", projectId: "ws_1", online: ["u_ada"] }],
    ["revoked", { kind: "revoked", projectId: "ws_1" }],
    ...REFUSED,
  ])("%s changes nothing", async (_name, payload) => {
    const { readsAtMount } = await mounted();

    await frame(payload);

    expect(reads()).toBe(readsAtMount);
    expect(cached()).toEqual(["ses_a", "ses_b"]);
  });

  it("hears nothing once unmounted", async () => {
    const { hook, readsAtMount } = await mounted();
    hook.unmount();
    await act(async () => {});

    await frame({ kind: "resync" });

    expect(reads()).toBe(readsAtMount);
    expect(cached()).toEqual(["ses_a", "ses_b"]);
  });
});

describe("an open Session's comments", () => {
  /** Session `ses_a` open and its (empty) comments loaded. */
  async function open() {
    const hook = renderHook(() => useSessionComments("rp_1", "ses_a"));
    await act(async () => {});
    return hook;
  }
  const shown = (hook: Awaited<ReturnType<typeof open>>) =>
    (hook.result.current?.byAnchor["row-1"] ?? []).map((c) => c.id);

  it("commentUpsert for this Session shows the comment without re-reading", async () => {
    const hook = await open();

    await frame({ kind: "commentUpsert", sessionId: "ses_a", comment: comment("ses_a", "c1") });

    expect(shown(hook)).toEqual(["c1"]);
    expect(listComments).toHaveBeenCalledTimes(1);
  });

  it("commentUpsert for another Session is not shown", async () => {
    const hook = await open();

    await frame({ kind: "commentUpsert", sessionId: "ses_b", comment: comment("ses_b", "c1") });

    expect(shown(hook)).toEqual([]);
  });

  it("resync re-reads the comments", async () => {
    const hook = await open();
    listComments.mockResolvedValue({
      byAnchor: { "row-1": [comment("ses_a", "c9")] },
      session: [],
    });

    await frame({ kind: "resync" });

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(shown(hook)).toEqual(["c9"]);
  });

  it.each([
    ["boardChanged", { kind: "boardChanged" }],
    ["entryUpsert", { kind: "entryUpsert", sessionId: "ses_a", change: "updated", entry: {} }],
    ["presence", { kind: "presence", projectId: "ws_1", online: ["u_ada"] }],
    ["revoked", { kind: "revoked", projectId: "ws_1" }],
    ...REFUSED,
  ])("%s changes nothing", async (_name, payload) => {
    const hook = await open();
    await frame({ kind: "commentUpsert", sessionId: "ses_a", comment: comment("ses_a", "c1") });

    await frame(payload);

    expect(shown(hook)).toEqual(["c1"]);
    expect(listComments).toHaveBeenCalledTimes(1);
  });
});
