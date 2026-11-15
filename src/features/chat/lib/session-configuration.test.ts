// Setting a session's configuration, through the module's own interface:
// `pick` over an in-memory agents backend, an in-memory session and an
// in-memory preference store. No store, no Tauri, no DOM.
//
// The table over every knob, through the store's actions, is
// `../stores/chat-store.configuration.test.ts`. This suite is for what is
// easier to say here: what `pick` answers, what a knob's descriptor decides,
// and the order things happen in.

import { beforeEach, describe, expect, it } from "vitest";
import type { ChatSession } from "@/types/agent";
import type { SessionKey } from "@/types/agents";
import {
  KNOBS,
  createSessionConfiguration,
  type ConfigurationAgentsPort,
  type SessionConfiguration,
} from "./session-configuration";

const TAB = "tab-1";
const KEY: SessionKey = { agent_id: "agent-1", session_id: "acp-1" };

/** One push the fake backend received. */
type Push = { cmd: keyof ConfigurationAgentsPort; value: unknown; configId?: string };

let sessions: Record<string, ChatSession>;
let pushes: Push[];
/** Decides how the backend answers a push. Default: it accepts. */
let answer: (push: Push) => Promise<void>;
let prefs: { modes: Record<string, string | null>; effort?: string; options: unknown[] };
let refusals: string[];
let configuration: SessionConfiguration;

const session = () => sessions[TAB]!;

/** A session on `agentType`, bound unless told otherwise. */
function open(agentType: string, fields: Partial<ChatSession> = {}, bound = true) {
  sessions[TAB] = {
    id: TAB,
    agentType,
    ...(bound ? { acpAgentId: KEY.agent_id, acpSessionId: KEY.session_id } : {}),
    ...fields,
  } as ChatSession;
}

function held() {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  sessions = {};
  pushes = [];
  answer = async () => {};
  prefs = { modes: {}, options: [] };
  refusals = [];
  const record =
    (cmd: Push["cmd"]) =>
    (key: SessionKey, value: unknown): Promise<void> => {
      expect(key).toEqual(KEY);
      const push = { cmd, value };
      pushes.push(push);
      return answer(push);
    };
  configuration = createSessionConfiguration({
    agents: {
      setMode: record("setMode"),
      setModel: record("setModel"),
      setEffort: record("setEffort"),
      setConfigOption: (key, configId, value) => {
        expect(key).toEqual(KEY);
        const push: Push = { cmd: "setConfigOption", configId, value };
        pushes.push(push);
        return answer(push);
      },
    },
    sessions: {
      get: (tabId) => sessions[tabId],
      update: (tabId, recipe) => {
        const found = sessions[tabId];
        if (found) recipe(found);
      },
    },
    prefs: {
      saveMode: (agentType, mode) => {
        prefs.modes[agentType] = mode;
      },
      saveEffort: (effort) => {
        prefs.effort = effort;
      },
      saveOption: (agentType, configId, value) => {
        prefs.options.push([agentType, configId, value]);
      },
    },
    report: { refused: (message) => refusals.push(message) },
  });
});

describe("pick", () => {
  it("answers `applied` once the agent has taken the pick", async () => {
    open("codex", { acpCurrentMode: "auto" });

    const outcome = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    expect(session().acpCurrentMode, "shown before the agent answers").toBe("read-only");

    expect(await outcome).toBe("applied");
    expect(pushes).toEqual([{ cmd: "setMode", value: "read-only" }]);
    expect(prefs.modes).toEqual({ codex: "read-only" });
    expect(refusals).toEqual([]);
  });

  it("answers `refused`, puts the composer back and passes on the agent's words", async () => {
    open("codex", { acpCurrentModel: "sonnet" });
    answer = async () => {
      throw "model 'opus' is not in the catalogue";
    };

    expect(await configuration.pick(TAB, KNOBS.model, "opus")).toBe("refused");

    expect(session().acpCurrentModel).toBe("sonnet");
    expect(refusals).toEqual(["model 'opus' is not in the catalogue"]);
  });

  it("leaves the composer alone when the agent has moved it since the pick", async () => {
    open("codex", { acpCurrentMode: "auto" });
    const push = held();
    answer = () => push.promise;

    const outcome = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    // The agent reports a mode of its own while the push is out.
    session().acpCurrentMode = "full-access";
    push.reject("busy");

    expect(await outcome).toBe("refused");
    expect(session().acpCurrentMode).toBe("full-access");
  });

  it("answers `kept-for-bind` for a pick with no session to push to", async () => {
    open("codex", {}, false);

    expect(await configuration.pick(TAB, KNOBS.acpMode, "read-only")).toBe("kept-for-bind");

    expect(pushes).toEqual([]);
    // The bind reads the pick from the flag, and pushes it before the first prompt.
    expect(session()).toMatchObject({ acpCurrentMode: "read-only", acpModeExplicit: true });
    expect(prefs.modes).toEqual({ codex: "read-only" });
  });

  it("answers `refused` for a tab that has no session", async () => {
    expect(await configuration.pick("nobody", KNOBS.model, "opus")).toBe("refused");
    expect(pushes).toEqual([]);
  });
});

describe("what a knob decides", () => {
  it("a mode pick is the user's: it is marked explicit and releases a held resume", async () => {
    open("codex", { acpCurrentMode: "auto", unrestoredModeId: "read-only" });
    await configuration.pick(TAB, KNOBS.acpMode, "auto");
    expect(session()).toMatchObject({ acpModeExplicit: true, unrestoredModeId: undefined });

    open("claude-code", { unrestoredModeId: "plan" });
    await configuration.pick(TAB, KNOBS.claudeMode, "plan");
    expect(session()).toMatchObject({
      claudePermissionMode: "plan",
      claudePermissionModeExplicit: true,
      unrestoredModeId: undefined,
    });
  });

  it("picking Claude's `default` forgets the remembered mode rather than storing it", async () => {
    open("claude-code");
    await configuration.pick(TAB, KNOBS.claudeMode, "bypassPermissions");
    expect(prefs.modes).toEqual({ "claude-code": "bypassPermissions" });

    await configuration.pick(TAB, KNOBS.claudeMode, "default");
    expect(prefs.modes).toEqual({ "claude-code": null });
  });

  it("a plan approval's mode is the session's, not the user's: nothing is remembered", async () => {
    open("claude-code", { claudePermissionMode: "plan" });

    expect(await configuration.pick(TAB, KNOBS.planExitMode, "acceptEdits")).toBe("applied");

    expect(pushes).toEqual([{ cmd: "setMode", value: "acceptEdits" }]);
    expect(session()).toMatchObject({
      claudePermissionMode: "acceptEdits",
      acpCurrentMode: "acceptEdits",
    });
    expect(session().claudePermissionModeExplicit).toBeUndefined();
    expect(prefs.modes).toEqual({});
  });

  it("the model is not remembered", async () => {
    open("codex");
    await configuration.pick(TAB, KNOBS.model, "opus");
    expect(prefs).toEqual({ modes: {}, options: [] });
  });

  it("the effort is remembered once, whatever the agent", async () => {
    open("atlas-agent");
    await configuration.pick(TAB, KNOBS.effort, "high");
    expect(pushes).toEqual([{ cmd: "setEffort", value: "high" }]);
    expect(prefs.effort).toBe("high");
  });

  it("an option shows nothing until the agent answers, and is remembered per agent", async () => {
    const advertised = [{ id: "web", name: "Web search", type: "boolean", currentValue: false }];
    open("codex", { acpConfigOptions: advertised });

    expect(await configuration.pick(TAB, KNOBS.option("web"), true)).toBe("applied");

    expect(pushes).toEqual([{ cmd: "setConfigOption", configId: "web", value: true }]);
    expect(session().acpConfigOptions).toBe(advertised);
    expect(prefs.options).toEqual([["codex", "web", true]]);
  });

  it("an option cannot be picked before the session has advertised it", async () => {
    open("codex", {}, false);
    expect(await configuration.pick(TAB, KNOBS.option("web"), true)).toBe("refused");
    expect(pushes).toEqual([]);
    expect(prefs.options).toEqual([]);
  });
});
