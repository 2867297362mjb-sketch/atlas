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
import { FIXTURES, REPO } from "../lib/tool-changes.fixtures";

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
  // Pinned as it stands, disagreements included, so a change to any one view
  // shows here as a changed line.
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
          ],
          "timeline": [
            "Created src/known.ts +1 −0 opens diff",
          ],
          "tree": "+1 −0",
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
            "Edited src/x.ts +0 −0 opens diff",
          ],
          "tree": "+3 −0",
          "viewer": [
            "added src/x.ts +3 −0",
          ],
        },
        "diff block only": {
          "card": [],
          "timeline": [
            "Edited src/app.ts +2 −1 opens diff",
          ],
          "tree": "+0 −0",
          "viewer": [
            "modified src/app.ts +2 −1",
          ],
        },
        "diff block only, classed as an edit with a location": {
          "card": [
            "edited src/app.ts +0 −0",
          ],
          "timeline": [
            "Edited src/app.ts +2 −1 opens diff",
          ],
          "tree": "+0 −0",
          "viewer": [
            "modified src/app.ts +2 −1",
          ],
        },
        "diff block that creates a file": {
          "card": [],
          "timeline": [
            "Created src/new.ts +2 −0 opens diff",
          ],
          "tree": "+0 −0",
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
            "edit +0 −0 opens none",
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
