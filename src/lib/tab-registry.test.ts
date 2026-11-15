// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

import {
  ORG_SCOPED_TYPES,
  PROJECTLESS_TYPES,
  TAB_PLACEMENT,
  TAB_TYPES,
  WINDOW_TYPES,
  type TabType,
} from "@/lib/constants";
import {
  IDLE_EXPENSIVE_TYPES_LIST,
  PERSISTENT_TYPES_LIST,
} from "@/features/layout/components/tab-panels";
import { isFileTab } from "@/features/explorer/lib/file-tabs";
import { SURFACES } from "@/features/layout/lib/surfaces";
import { tabIcons } from "@/features/layout/components/pane-tab";

/**
 * What every tab type is, written out as literals: the values each list had
 * when the facts lived in separate files. The lists the app reads must still
 * equal these.
 */

const TYPES = [
  "chat",
  "canvas",
  "browser",
  "tasks",
  "editor",
  "files",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "commit",
  "session-changes",
  "pull-request",
  "pull-requests",
  "session-pull-requests",
  "source-control",
  "log",
  "media",
  "svg",
  "pdf",
  "notebook",
  "unsupported",
  "usage",
  "artifacts",
  "inbox",
  "agent",
  "agent-panel",
  "comms-draft",
  "spaces",
  "team-chat",
] as const;

const PLACEMENT: Record<(typeof TYPES)[number], string> = {
  chat: "session",
  editor: "surface 320",
  files: "surface 240",
  terminal: "surface 280",
  browser: "surface 360",
  diff: "surface 360",
  commit: "surface 360",
  "session-changes": "surface 320",
  "pull-request": "surface 360",
  "pull-requests": "surface 360",
  "session-pull-requests": "surface 320",
  "source-control": "surface 300",
  "team-chat": "surface-or-destination 320",
  "agent-panel": "surface 320",
  "comms-draft": "surface 320",
  log: "surface 300",
  pdf: "surface 320",
  notebook: "surface 360",
  media: "surface 240",
  svg: "surface 240",
  unsupported: "surface 240",
  tasks: "surface 240",
  artifacts: "destination",
  inbox: "destination",
  agent: "destination",
  usage: "destination",
  knowledge: "destination",
  "knowledge-graph": "destination",
  memory: "destination",
  canvas: "destination",
  spaces: "destination",
};

const PROJECTLESS = [
  "usage",
  "inbox",
  "agent",
  "agent-panel",
  "comms-draft",
  "spaces",
  "team-chat",
];
const WINDOW = ["agent-panel", "team-chat"];
const ORG_SCOPED = ["usage", "comms-draft", "spaces"];
const PERSISTENT = ["chat", "browser", "editor", "terminal", "pdf", "agent-panel", "team-chat"];
const IDLE_EXPENSIVE = ["browser", "terminal", "pdf"];
const FILE_BACKED = ["editor", "media", "svg", "pdf", "notebook", "unsupported"];

/** The ⌘T list, in the order it is offered. */
const LAUNCHER = [
  ["chat", "Agent", "A"],
  ["terminal", "Terminal", "T"],
  ["browser", "Browser", "B"],
  ["editor", "New file", "N"],
  ["files", "Files", "F"],
  ["source-control", "Source control", "G"],
  ["pull-requests", "Pull requests", "P"],
  ["team-chat", "Team chat", "C"],
  ["agent-panel", "Ask Atlas", "O"],
  ["log", "Log", "L"],
];

/** `types`, in the order the tab types are declared. */
const inTypeOrder = (types: Iterable<string>) => {
  const set = new Set(types);
  return TYPES.filter((t) => set.has(t));
};

describe("tab type facts", () => {
  it("are the same tab types, in the same order", () => {
    expect([...TAB_TYPES]).toEqual([...TYPES]);
  });

  it("place every type where it was placed", () => {
    const placed = Object.fromEntries(
      TAB_TYPES.map((type) => {
        const p: { kind: string; minWidth?: number } = TAB_PLACEMENT[type];
        return [type, p.minWidth === undefined ? p.kind : `${p.kind} ${p.minWidth}`];
      }),
    );
    expect(placed).toEqual(PLACEMENT);
  });

  it("scope the same types to no project, the window and the Organisation", () => {
    expect(inTypeOrder(PROJECTLESS_TYPES)).toEqual(PROJECTLESS);
    expect(inTypeOrder(WINDOW_TYPES)).toEqual(WINDOW);
    expect(inTypeOrder(ORG_SCOPED_TYPES)).toEqual(ORG_SCOPED);
    expect(PROJECTLESS_TYPES.size).toBe(PROJECTLESS.length);
    expect(WINDOW_TYPES.size).toBe(WINDOW.length);
    expect(ORG_SCOPED_TYPES.size).toBe(ORG_SCOPED.length);
  });

  it("keep the same types mounted, and drop the same ones in a background project", () => {
    expect(inTypeOrder(PERSISTENT_TYPES_LIST)).toEqual(PERSISTENT);
    expect(inTypeOrder(IDLE_EXPENSIVE_TYPES_LIST)).toEqual(IDLE_EXPENSIVE);
    expect(PERSISTENT_TYPES_LIST).toHaveLength(PERSISTENT.length);
    expect(IDLE_EXPENSIVE_TYPES_LIST).toHaveLength(IDLE_EXPENSIVE.length);
  });

  it("call the same types file tabs", () => {
    expect(TYPES.filter((t) => isFileTab(t))).toEqual(FILE_BACKED);
  });

  it("offer the same launcher entries, in the same order, under the tab's own icon", () => {
    expect(SURFACES.map((s) => [s.type, s.label, s.key])).toEqual(LAUNCHER);
    for (const s of SURFACES) expect(s.icon, s.type).toBe(tabIcons[s.type as TabType]);
  });
});
