// @vitest-environment happy-dom
//
// What a turn changed, as each view of it says.
//
// Four views answer "which files did this turn change, and by how much": the
// timeline line of each tool call, the changed-files viewer, the turn card and
// the card's tree. Every fixture turn (`tool-changes.fixtures.ts`) is played
// through the store's real delta path, and each view is then asked from the
// session the UI would render.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { RowKind, type MarkerRow } from "@tryatlas/design/session";
import type { AgentDelta, ToolCall } from "@/types/agents";
import { statusOfSource } from "@/features/git/lib/use-turn-review-files";
import { useChatStore } from "./chat-store";
import { projectRows } from "../lib/turn-rows";
import { collectTurnEdits } from "../lib/turn-edits";
import { buildChangedFilesTree, changedFilesOf, sumStats } from "../lib/changed-files-tree";
import { countChangedLines } from "../lib/tool-files";
import { enginePatchFiles } from "../lib/engine-patch";
import { changesOfToolCall, changesOfTurn } from "../lib/tool-changes";
import { toRepoRelative } from "../lib/open-turn-diff";
import { FIXTURES, REPO, fixture } from "../lib/tool-changes.fixtures";

const TAB = "tab-1";
const AGENT = "agent-1";
const ACP = "acp-session-1";

type Kind = AgentDelta["kind"];
type Body<K extends Kind> = Omit<
  Extract<AgentDelta, { kind: K }>,
  "kind" | "agent_id" | "session_id" | "seq"
>;

function d<K extends Kind>(kind: K, body: Body<K>): AgentDelta {
  // One generic spread TypeScript cannot narrow back to the union member.
  return { kind, agent_id: AGENT, session_id: ACP, seq: 0, ...body } as unknown as AgentDelta;
}

const apply = (...deltas: AgentDelta[]) => {
  for (const delta of deltas) useChatStore.getState().actions.applyAgentDelta(delta);
};
const session = () => useChatStore.getState().sessions[TAB];

const upsert = (tool_call: ToolCall) => d("tool_call_upserted", { message_id: "t", tool_call });

/** A bound session, a prompt, and a running turn. */
function openTurn() {
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "claude-code");
  actions.setAcpBinding(TAB, AGENT, ACP, REPO);
  actions.addMessage(TAB, "user", "make the change");
  apply(d("status", { status: "running", turn_seq: 1 }));
}

function closeTurn() {
  apply(
    d("text_chunk", { message_id: "m", delta: "Done." }),
    d("turn_finished", { stop_reason: "end_turn", turn_seq: 1 }),
  );
}

/** One whole turn of `calls`, each arriving complete. */
function playTurn(calls: ToolCall[]) {
  openTurn();
  apply(...calls.map(upsert));
  closeTurn();
}

const size = (c: { added: number; removed: number }) => `+${c.added} −${c.removed}`;

/** The timeline's line for each of the turn's tool calls. */
function timelineLines(): MarkerRow[] {
  const messages = session().messages;
  const opts = { expanded: new Set<string>(), streaming: false };
  const folded = projectRows(messages, { ...opts, expandedTurns: new Set<string>() });
  const open = new Set(folded.turns.map((t) => `wk:${t.id}`));
  return projectRows(messages, { ...opts, expandedTurns: open }).rows.flatMap((row) =>
    row.kind === RowKind.MarkerGroup ? row.markers : row.kind === RowKind.Marker ? [row] : [],
  );
}

/** The viewer's files for the turn, each with the counts it shows. */
function viewerFiles() {
  const messages = session().messages;
  const first = messages.find((m) => m.role === "assistant");
  const edits = collectTurnEdits(messages, `t:${first?.id}`, REPO);
  return edits.files.map((path) => {
    const source = edits.sources[path];
    const status = statusOfSource(source, edits.excerpts.has(path));
    const previous = edits.renames?.[path];
    // The viewer shows the engine's own diff by its hunks, and any other pair
    // by the diff of its two texts.
    const hunks =
      source.patch !== undefined && source.patch !== ""
        ? enginePatchFiles({ paths: [path], patch: source.patch })?.[0]
        : undefined;
    const counts = hunks ?? countChangedLines(source.old, source.new);
    return {
      path,
      status: status === "modified" && previous ? "renamed" : status,
      previous,
      added: counts.added,
      removed: counts.removed,
    };
  });
}

/** The turn card's files: what it edited, reads left out. */
function cardFiles() {
  const settled = session().messages.filter((m) => m.turnSummary);
  const summary = settled[settled.length - 1]?.turnSummary;
  return changedFilesOf(summary?.files ?? [], REPO);
}

/** Every view's answer, one line per file, for reading side by side. */
function views() {
  const card = cardFiles();
  return {
    timeline: timelineLines().map((m) =>
      `${m.verb} ${m.detail} ${size(m)} opens ${m.opens}`.replace(/\s+/g, " "),
    ),
    viewer: viewerFiles().map(
      (f) => `${f.status} ${f.path}${f.previous ? ` (was ${f.previous})` : ""} ${size(f)}`,
    ),
    card: card.map(
      (f) =>
        `${f.created ? "added" : "edited"} ${f.path}${f.movedFrom ? ` (was ${f.movedFrom})` : ""} ${size(f)}`,
    ),
    tree: size(
      sumStats(buildChangedFilesTree(card).map((n) => (n.kind === "dir" ? n.stat : n.file))),
    ),
  };
}

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
});

describe("what each view says a turn changed", () => {
  // The record: every view's answer for every fixture, so a change to any one
  // view shows here as a changed line. `every view agrees` below is the rule.
  it("is recorded for every fixture", () => {
    const said: Record<string, ReturnType<typeof views>> = {};
    for (const fixture of FIXTURES) {
      useChatStore.setState({ sessions: {} });
      playTurn(fixture.calls);
      said[fixture.name] = views();
    }
    expect(said).toMatchInlineSnapshot(`
      {
        "a diff block beside arguments naming another file": {
          "card": [
            "added src/known.ts +1 −0",
            "added src/other.ts +1 −0",
          ],
          "timeline": [
            "Created src/known.ts +2 −0 opens diff",
          ],
          "tree": "+2 −0",
          "viewer": [
            "added src/known.ts +1 −0",
            "added src/other.ts +1 −0",
          ],
        },
        "a failed edit": {
          "card": [
            "edited src/a.ts +1 −1",
          ],
          "timeline": [
            "Edited src/a.ts +1 −1 opens diff",
          ],
          "tree": "+1 −1",
          "viewer": [
            "modified src/a.ts +1 −1",
          ],
        },
        "a file created, then renamed": {
          "card": [
            "added src/d.rs +2 −1",
          ],
          "timeline": [
            "Created src/c.rs +1 −0 opens diff",
            "Edited src/c.rs +1 −1 opens diff",
          ],
          "tree": "+2 −1",
          "viewer": [
            "added src/d.rs +1 −0",
          ],
        },
        "a file edited, then renamed": {
          "card": [
            "edited src/d.rs (was src/c.rs) +2 −2",
          ],
          "timeline": [
            "Edited src/c.rs +1 −1 opens diff",
            "Edited src/c.rs +1 −1 opens diff",
          ],
          "tree": "+2 −2",
          "viewer": [
            "renamed src/d.rs (was src/c.rs) +2 −2",
          ],
        },
        "a file written, then edited": {
          "card": [
            "edited src/w.ts +3 −1",
          ],
          "timeline": [
            "Created src/w.ts +2 −0 opens diff",
            "Edited src/w.ts +1 −1 opens diff",
          ],
          "tree": "+3 −1",
          "viewer": [
            "added src/w.ts +2 −0",
          ],
        },
        "a read, a search and a command": {
          "card": [],
          "timeline": [
            "Read src/a.ts +0 −0 opens none",
            "Searched expiresAt +0 −0 opens output",
            "Ran bun test +0 −0 opens output",
          ],
          "tree": "+0 −0",
          "viewer": [],
        },
        "arguments only, still running": {
          "card": [
            "edited src/auth.ts +2 −1",
          ],
          "timeline": [
            "Edited src/auth.ts +2 −1 opens diff",
          ],
          "tree": "+2 −1",
          "viewer": [
            "modified src/auth.ts +2 −1",
          ],
        },
        "create, named by its title": {
          "card": [
            "added src/x.ts +3 −0",
          ],
          "timeline": [
            "Created src/x.ts +3 −0 opens diff",
          ],
          "tree": "+3 −0",
          "viewer": [
            "added src/x.ts +3 −0",
          ],
        },
        "diff block only": {
          "card": [
            "edited src/app.ts +2 −1",
          ],
          "timeline": [
            "Edited src/app.ts +2 −1 opens diff",
          ],
          "tree": "+2 −1",
          "viewer": [
            "modified src/app.ts +2 −1",
          ],
        },
        "diff block only, classed as an edit with a location": {
          "card": [
            "edited src/app.ts +2 −1",
          ],
          "timeline": [
            "Edited src/app.ts +2 −1 opens diff",
          ],
          "tree": "+2 −1",
          "viewer": [
            "modified src/app.ts +2 −1",
          ],
        },
        "diff block that creates a file": {
          "card": [
            "added src/new.ts +2 −0",
          ],
          "timeline": [
            "Created src/new.ts +2 −0 opens diff",
          ],
          "tree": "+2 −0",
          "viewer": [
            "added src/new.ts +2 −0",
          ],
        },
        "edit with a path in its arguments and a diff block": {
          "card": [
            "edited src/session.ts +1 −0",
          ],
          "timeline": [
            "Edited src/session.ts +1 −0 opens diff",
          ],
          "tree": "+1 −0",
          "viewer": [
            "modified src/session.ts +1 −0",
          ],
        },
        "locations only": {
          "card": [
            "edited src/loc.ts +0 −0",
          ],
          "timeline": [
            "Edited src/loc.ts +0 −0 opens diff",
          ],
          "tree": "+0 −0",
          "viewer": [],
        },
        "native delete": {
          "card": [
            "edited src/gone.rs +0 −1",
          ],
          "timeline": [
            "Edited src/gone.rs +0 −1 opens diff",
          ],
          "tree": "+0 −1",
          "viewer": [
            "deleted src/gone.rs +0 −1",
          ],
        },
        "native edit, still running": {
          "card": [
            "edited src/lib.rs +0 −0",
          ],
          "timeline": [
            "Edited src/lib.rs +0 −0 opens diff",
          ],
          "tree": "+0 −0",
          "viewer": [],
        },
        "native patch naming several files": {
          "card": [
            "edited src/a.rs +1 −0",
            "added src/new.rs +2 −0",
          ],
          "timeline": [
            "Edited src/a.rs +3 −0 opens diff",
          ],
          "tree": "+3 −0",
          "viewer": [
            "modified src/a.rs +1 −0",
            "added src/new.rs +2 −0",
          ],
        },
        "native rename": {
          "card": [
            "edited src/d.rs (was src/c.rs) +0 −0",
          ],
          "timeline": [
            "Edited src/c.rs +0 −0 opens diff",
          ],
          "tree": "+0 −0",
          "viewer": [
            "renamed src/d.rs (was src/c.rs) +0 −0",
          ],
        },
        "native rename plus edit": {
          "card": [
            "edited src/d.rs (was src/c.rs) +1 −1",
          ],
          "timeline": [
            "Edited src/c.rs +1 −1 opens diff",
          ],
          "tree": "+1 −1",
          "viewer": [
            "renamed src/d.rs (was src/c.rs) +1 −1",
          ],
        },
        "the same file edited twice": {
          "card": [
            "edited src/a.ts +3 −2",
          ],
          "timeline": [
            "Edited src/a.ts +1 −1 opens diff",
            "Edited src/a.ts +2 −1 opens diff",
          ],
          "tree": "+3 −2",
          "viewer": [
            "modified src/a.ts +3 −2",
          ],
        },
      }
    `);
  });
});

/** The turn card's edits as the store froze them, by the paths the calls gave. */
function frozenEdits() {
  const settled = session().messages.filter((m) => m.turnSummary);
  const files = settled[settled.length - 1]?.turnSummary?.files ?? [];
  return files
    .filter((f) => f.kind === "edit")
    .map((f) => ({
      path: f.path,
      previousPath: f.movedFrom,
      added: f.added,
      removed: f.removed,
      created: f.created === true,
    }));
}

/** The one reading's answer for a turn of `calls`, in the card's terms. */
function readingOf(calls: ToolCall[]) {
  return changesOfTurn(calls).map((c) => ({
    path: c.path,
    previousPath: c.previousPath,
    added: c.added,
    removed: c.removed,
    created: c.kind === "added",
  }));
}

describe("the turn card's counts, as the deltas arrive", () => {
  it.each(FIXTURES.map((f) => [f.name, f.calls] as const))(
    "equal the reading of the turn's final calls: %s",
    (_, calls) => {
      playTurn(calls);
      expect(frozenEdits()).toEqual(readingOf(calls));
    },
  );

  it("counts an edit reported only as a diff block", () => {
    // It was in the timeline and the viewer and counted nothing here: the
    // card read a call's arguments and locations, never its blocks.
    const { calls } = fixture("diff block only");
    playTurn(calls);
    expect(frozenEdits()).toEqual([
      {
        path: "/repo/src/app.ts",
        previousPath: undefined,
        added: 2,
        removed: 1,
        created: false,
      },
    ]);
  });

  it("counts a file a diff block created as created", () => {
    playTurn(fixture("diff block that creates a file").calls);
    expect(frozenEdits().map((f) => [f.path, f.added, f.created])).toEqual([
      ["/repo/src/new.ts", 2, true],
    ]);
  });

  it("is the same when the diff block arrives after the arguments", () => {
    const [final] = fixture("edit with a path in its arguments and a diff block").calls;
    const { content_blocks: _blocks, ...early } = final;
    openTurn();
    apply(upsert({ ...early, status: "running" }));
    const before = Object.values(session().turnScratch!.tools);
    apply(upsert(final));
    // One file under the call's id, replaced whole by the later sighting.
    expect(Object.values(session().turnScratch!.tools)).toEqual(before);
    closeTurn();
    expect(frozenEdits()).toEqual(readingOf([final]));
  });

  it("counts a call that names nothing until its diff block arrives", () => {
    const [final] = fixture("diff block only").calls;
    const { content_blocks: _blocks, ...early } = final;
    openTurn();
    apply(upsert({ ...early, status: "pending" }));
    expect(session().turnScratch!.tools).toEqual({});
    apply(upsert({ ...early, status: "running" }), upsert(final));
    closeTurn();
    expect(frozenEdits()).toEqual(readingOf([final]));
  });

  it("keeps what a call recorded when a later sighting carries nothing", () => {
    const [final] = fixture("diff block only").calls;
    openTurn();
    apply(upsert(final), upsert({ ...final, arguments: {}, content_blocks: undefined }));
    closeTurn();
    expect(frozenEdits()).toEqual(readingOf([final]));
  });

  it("is the same for a session reloaded from its log", () => {
    // `replaceMessages` rebuilds every turn's card from the loaded calls.
    const { calls } = fixture("a file edited, then renamed");
    playTurn(calls);
    const live = frozenEdits();
    const { actions } = useChatStore.getState();
    actions.replaceMessages(
      TAB,
      session().messages.map(({ turnSummary: _summary, ...m }) => m),
    );
    expect(frozenEdits()).toEqual(live);
  });
});

describe("every view agrees with the one reading", () => {
  const pathKey = (path: string) => toRepoRelative(path, REPO);
  const sum = (files: readonly { added: number; removed: number }[]) => size(sumStats(files));

  /** Fixtures where one file is touched by more than one call, so the two
   *  ways calls combine (`TurnFoldOptions.combine`) give different answers:
   *  the turn card adds every call's lines up, the viewer shows the turn's
   *  first text against its last. Everywhere else they are the same. */
  const COMBINE_DIFFERENTLY = ["a file written, then edited", "a file created, then renamed"];

  describe.each(FIXTURES.map((f) => [f.name, f.calls] as const))("%s", (name, calls) => {
    beforeEach(() => playTurn(calls));

    const perCall = () => changesOfTurn(calls, { pathKey });
    const net = () => changesOfTurn(calls, { pathKey, combine: "net" });

    it("the timeline names each call's first file and counts all of them", () => {
      const lines = timelineLines();
      expect(lines).toHaveLength(calls.length);
      calls.forEach((call, i) => {
        const changes = changesOfToolCall(call);
        expect(lines[i].opens === "diff").toBe(changes.length > 0);
        if (changes.length === 0) return;
        expect(lines[i].path).toBe(changes[0].path);
        expect(size(lines[i])).toBe(sum(changes));
      });
    });

    it("the turn card lists the reading's files, with its counts", () => {
      expect(cardFiles().map((f) => [f.path, f.movedFrom, f.added, f.removed, f.created])).toEqual(
        perCall().map((c) => [c.path, c.previousPath, c.added, c.removed, c.kind === "added"]),
      );
    });

    it("the tree totals what the card lists, which is what the timeline counted", () => {
      const card = cardFiles();
      const tree = buildChangedFilesTree(card).map((n) => (n.kind === "dir" ? n.stat : n.file));
      expect(sum(tree)).toBe(sum(card));
      expect(sum(card)).toBe(sum(timelineLines()));
    });

    it("the viewer lists the reading's files that have text, at its net counts", () => {
      expect(viewerFiles().map((f) => [f.path, f.previous, f.status, f.added, f.removed])).toEqual(
        net()
          .filter((c) => c.content)
          .map((c) => [c.path, c.previousPath, c.kind, c.added, c.removed]),
      );
    });

    it("the card and the viewer name the same files", () => {
      // The viewer leaves out only a file no call reported the text of: there
      // is nothing to diff.
      const textless = perCall()
        .filter((c) => !c.content)
        .map((c) => c.path);
      expect(viewerFiles().map((f) => f.path)).toEqual(
        cardFiles()
          .map((f) => f.path)
          .filter((path) => !textless.includes(path)),
      );
    });

    it("the card and the viewer count the same, unless several calls touched a file", () => {
      const counts = (files: { path: string; added: number; removed: number }[]) =>
        files.map((f) => `${f.path} ${size(f)}`);
      const viewer = viewerFiles();
      const card = cardFiles().filter((f) => viewer.some((v) => v.path === f.path));
      if (COMBINE_DIFFERENTLY.includes(name)) expect(counts(card)).not.toEqual(counts(viewer));
      else expect(counts(card)).toEqual(counts(viewer));
    });
  });
});
