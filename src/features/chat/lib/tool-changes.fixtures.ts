// One set of tool calls, as the session-delta wire carries them, for every
// test of "which files did this call change": each shape an edit arrives in,
// and the calls that must read as no edit at all.
//
// A fixture is one turn: usually a single call, several where the point is how
// calls to the same file combine. The shapes are the ones the mock backend
// plays (`src/dev/mock-backend/scenarios/chat-turn-changes.ts`) and the native
// agent's sink writes (`engine-patch.ts` has the format).

import type { ToolCall } from "@/bindings/agent-wire/ToolCall";

export const REPO = "/repo";
const abs = (path: string) => `${REPO}/${path}`;

let n = 0;
function call(over: Partial<ToolCall> & Pick<ToolCall, "tool_name">): ToolCall {
  return {
    id: `fx-${++n}`,
    title: null,
    kind: "edit",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    ...over,
  };
}

const sessionBefore = "export interface Session {\n  userId: string;\n  expiresAt: number;\n}\n";
const sessionAfter =
  "export interface Session {\n  userId: string;\n  expiresAt: number;\n  refreshedAt: number;\n}\n";

/** A fragment replaced: the text and its replacement, never the whole file. */
function replace(path: string, oldString: string, newString: string, over: Partial<ToolCall> = {}) {
  return call({
    tool_name: "Edit",
    title: `Edit ${path}`,
    arguments: { file_path: abs(path), old_string: oldString, new_string: newString },
    ...over,
  });
}

/** The native agent's edit: every file's text joined in `paths` order. */
function native(
  files: { path: string; text: string; kind?: string; movePath?: string; lines?: number }[],
  withChanges: boolean,
  over: Partial<ToolCall> = {},
) {
  const first = abs(files[0].path);
  const title = files.length === 1 ? `Edit ${first}` : `Edit ${first} (+${files.length - 1} more)`;
  let start = 0;
  const changes = files.map((f) => {
    // A rename's range stops before its `Moved to:` note.
    const own = f.lines ?? f.text.split("\n").length;
    const entry = {
      path: abs(f.path),
      kind: f.kind ?? "update",
      lines: [start, start + own],
      ...(f.movePath ? { movePath: abs(f.movePath) } : {}),
    };
    start += f.text.split("\n").length;
    return entry;
  });
  return call({
    tool_name: title,
    title,
    locations: files.map((f) => ({ path: abs(f.path) })),
    arguments: {
      paths: files.map((f) => abs(f.path)),
      patch: files.map((f) => f.text).join("\n"),
      ...(withChanges ? { changes } : {}),
    },
    ...over,
  });
}

const update = "@@ -1,3 +1,4 @@\n use a;\n+use b;\n \n fn f() {}\n";
const retitle = "@@ -1 +1 @@\n-fn old() {}\n+fn new() {}\n";

export interface TurnFixture {
  name: string;
  /** The turn's tool calls, in the order the agent made them. */
  calls: ToolCall[];
}

export const FIXTURES: TurnFixture[] = [
  {
    // What an agent that reports both sends: recognisable arguments, the
    // location, and the whole file either side as a diff block.
    name: "edit with a path in its arguments and a diff block",
    calls: [
      replace(
        "src/session.ts",
        "  expiresAt: number;\n",
        "  expiresAt: number;\n  refreshedAt: number;\n",
        {
          locations: [{ path: abs("src/session.ts"), line: 3 }],
          content_blocks: [
            {
              type: "diff",
              path: abs("src/session.ts"),
              oldText: sessionBefore,
              newText: sessionAfter,
            },
          ],
        },
      ),
    ],
  },
  {
    // An agent whose tool is its own: nothing in the arguments names a file,
    // and the edit is only in the block.
    name: "diff block only",
    calls: [
      call({
        tool_name: "apply_patch",
        kind: null,
        arguments: { patch_id: 7 },
        content_blocks: [
          { type: "diff", path: abs("src/app.ts"), oldText: "one\ntwo\n", newText: "one\n2\n3\n" },
        ],
      }),
    ],
  },
  {
    // The same, from an agent that also classes the call and names where.
    name: "diff block only, classed as an edit with a location",
    calls: [
      call({
        tool_name: "apply_patch",
        arguments: { patch_id: 8 },
        locations: [{ path: abs("src/app.ts") }],
        content_blocks: [
          { type: "diff", path: abs("src/app.ts"), oldText: "one\ntwo\n", newText: "one\n2\n3\n" },
        ],
      }),
    ],
  },
  {
    name: "diff block that creates a file",
    calls: [
      call({
        tool_name: "apply_patch",
        kind: null,
        content_blocks: [{ type: "diff", path: abs("src/new.ts"), newText: "hello\nworld\n" }],
      }),
    ],
  },
  {
    // In flight: the arguments have arrived and the diff block has not.
    name: "arguments only, still running",
    calls: [replace("src/auth.ts", "a\n", "b\nc\n", { status: "running" })],
  },
  {
    // The native edit before its patch text arrives: the files, nothing more.
    name: "native edit, still running",
    calls: [
      call({
        tool_name: `Edit ${abs("src/lib.rs")}`,
        status: "running",
        arguments: { paths: [abs("src/lib.rs")], patch: "" },
      }),
    ],
  },
  {
    name: "native patch naming several files",
    calls: [
      native(
        [
          { path: "src/a.rs", text: update },
          { path: "src/new.rs", text: "line one\nline two\n" },
        ],
        false,
      ),
    ],
  },
  {
    name: "native rename",
    calls: [
      native(
        [
          {
            path: "src/c.rs",
            text: "\n\nMoved to: /repo/src/d.rs",
            kind: "rename",
            lines: 0,
            movePath: "src/d.rs",
          },
        ],
        true,
      ),
    ],
  },
  {
    name: "native rename plus edit",
    calls: [
      native(
        [
          {
            path: "src/c.rs",
            text: `${retitle}\n\nMoved to: /repo/src/d.rs`,
            kind: "rename",
            lines: 4,
            movePath: "src/d.rs",
          },
        ],
        true,
      ),
    ],
  },
  {
    name: "native delete",
    calls: [native([{ path: "src/gone.rs", text: "fn gone() {}\n", kind: "delete" }], true)],
  },
  {
    // The name on the wire is the call's title for most adapters, so a whole
    // file written out is recognised by its kind.
    name: "create, named by its title",
    calls: [
      call({
        tool_name: "Write src/x.ts",
        title: "Write src/x.ts",
        arguments: { file_path: abs("src/x.ts"), content: "a\nb\nc\n" },
        locations: [{ path: abs("src/x.ts") }],
      }),
    ],
  },
  {
    name: "the same file edited twice",
    calls: [replace("src/a.ts", "one\n", "ONE\n"), replace("src/a.ts", "two\n", "TWO\nand more\n")],
  },
  {
    name: "a file written, then edited",
    calls: [
      call({
        tool_name: "Write",
        arguments: { file_path: abs("src/w.ts"), content: "one\ntwo\n" },
      }),
      replace("src/w.ts", "two\n", "TWO\n"),
    ],
  },
  {
    name: "a file edited, then renamed",
    calls: [
      native([{ path: "src/c.rs", text: "@@ -1 +1 @@\n-a\n+fn old() {}\n" }], false),
      native(
        [
          {
            path: "src/c.rs",
            text: `${retitle}\n\nMoved to: /repo/src/d.rs`,
            kind: "rename",
            lines: 4,
            movePath: "src/d.rs",
          },
        ],
        true,
      ),
    ],
  },
  {
    name: "a file created, then renamed",
    calls: [
      native([{ path: "src/c.rs", text: "fn old() {}\n", kind: "add" }], true),
      native(
        [
          {
            path: "src/c.rs",
            text: `${retitle}\n\nMoved to: /repo/src/d.rs`,
            kind: "rename",
            lines: 4,
            movePath: "src/d.rs",
          },
        ],
        true,
      ),
    ],
  },
  {
    name: "a failed edit",
    calls: [
      replace("src/a.ts", "one\n", "ONE\n", { status: "failed", result: "String not found" }),
    ],
  },
  {
    // An ACP agent that says where and nothing else.
    name: "locations only",
    calls: [
      call({ tool_name: "edit", arguments: {}, locations: [{ path: abs("src/loc.ts"), line: 3 }] }),
    ],
  },
  {
    // The arguments name one file and a block reports another.
    name: "a diff block beside arguments naming another file",
    calls: [
      call({
        tool_name: "Write",
        arguments: { file_path: abs("src/known.ts"), content: "a\n" },
        content_blocks: [{ type: "diff", path: abs("src/other.ts"), newText: "z\n" }],
      }),
    ],
  },
  {
    name: "a read, a search and a command",
    calls: [
      call({ tool_name: "Read", kind: "read", arguments: { file_path: abs("src/a.ts") } }),
      call({ tool_name: "Grep", kind: "search", arguments: { pattern: "expiresAt" } }),
      call({
        tool_name: "Bash",
        kind: "execute",
        arguments: { command: "bun test" },
        result: "ok",
        content_blocks: [{ type: "terminal", terminalId: "t1" }],
      }),
    ],
  },
];

export const fixture = (name: string): TurnFixture => {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`No fixture named "${name}"`);
  return found;
};
