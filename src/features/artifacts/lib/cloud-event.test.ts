import { describe, expect, it } from "vitest";

import { parseCloudEvent } from "./cloud-event";

const comment = { id: "c1", sessionId: "ses_1", body: "hello" };

describe("parseCloudEvent", () => {
  it.each([
    ["boardChanged", { kind: "boardChanged" }, { kind: "boardChanged" }],
    ["resync", { kind: "resync" }, { kind: "resync" }],
    [
      "entryUpsert",
      { kind: "entryUpsert", sessionId: "ses_1", change: "updated", entry: { id: "msg_1" } },
      { kind: "entryUpsert", sessionId: "ses_1", change: "updated", entry: { id: "msg_1" } },
    ],
    [
      "commentUpsert",
      { kind: "commentUpsert", sessionId: "ses_1", comment },
      { kind: "commentUpsert", sessionId: "ses_1", comment },
    ],
    [
      "presence",
      { kind: "presence", projectId: "ws_1", online: ["u_ada", "u_grace"] },
      { kind: "presence", projectId: "ws_1", online: ["u_ada", "u_grace"] },
    ],
    [
      "presence, nobody online",
      { kind: "presence", projectId: "ws_1", online: [] },
      { kind: "presence", projectId: "ws_1", online: [] },
    ],
    ["revoked", { kind: "revoked", projectId: "ws_1" }, { kind: "revoked", projectId: "ws_1" }],
  ])("reads a %s frame", (_name, raw, parsed) => {
    expect(parseCloudEvent(raw)).toEqual(parsed);
  });

  it("drops fields the kind does not carry", () => {
    expect(parseCloudEvent({ kind: "resync", sessionId: "ses_1" })).toEqual({ kind: "resync" });
    expect(parseCloudEvent({ kind: "revoked", projectId: "ws_1", online: ["u_ada"] })).toEqual({
      kind: "revoked",
      projectId: "ws_1",
    });
  });

  it.each([
    ["a kind this build does not know", { kind: "sessionArchived", sessionId: "ses_1" }],
    ["no kind", { sessionId: "ses_1" }],
    ["a kind that is not a string", { kind: 7 }],
    ["null", null],
    ["nothing", undefined],
    ["a string", "resync"],
    ["an array", [{ kind: "resync" }]],
    ["entryUpsert with no Session", { kind: "entryUpsert", change: "updated", entry: {} }],
    ["entryUpsert with an empty Session id", { kind: "entryUpsert", sessionId: "", change: "x" }],
    ["entryUpsert with no change", { kind: "entryUpsert", sessionId: "ses_1", entry: {} }],
    // The bug the Rust side's `rename_all_fields` test guards: a snake_case
    // field arrives, matches on `kind`, and must not be acted on.
    ["entryUpsert in snake_case", { kind: "entryUpsert", session_id: "ses_1", change: "x" }],
    ["commentUpsert with no Session", { kind: "commentUpsert", comment }],
    ["commentUpsert with no comment", { kind: "commentUpsert", sessionId: "ses_1" }],
    ["commentUpsert with a null comment", { kind: "commentUpsert", sessionId: "s", comment: null }],
    ["presence with no Project", { kind: "presence", online: ["u_ada"] }],
    ["presence with no roster", { kind: "presence", projectId: "ws_1" }],
    [
      "presence with a roster that is not a list",
      { kind: "presence", projectId: "w", online: "u" },
    ],
    ["presence with a roster of non-ids", { kind: "presence", projectId: "w", online: [1, 2] }],
    ["revoked with no Project", { kind: "revoked" }],
    ["revoked in snake_case", { kind: "revoked", project_id: "ws_1" }],
  ])("refuses %s", (_name, raw) => {
    expect(parseCloudEvent(raw)).toBeNull();
  });
});
