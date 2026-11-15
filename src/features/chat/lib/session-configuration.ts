/**
 * Setting a session's configuration: its permission mode, its model, its
 * reasoning effort and whatever options its agent advertises.
 *
 * Every one of them is the same sequence, so it is written once (`pick`):
 * show the pick in the composer, push it to the agent, take it back and say
 * why if the agent refuses, remember it for the next session. What differs
 * between them is a `Knob`: where the composer reads it, which command pushes
 * it, how it is remembered, and what a pick means before there is a session.
 *
 * Rust holds the agent's actual configuration. What is written here is the
 * composer's mirror of it, and the agent's own reports (`mode_changed`,
 * `model_changed`, `config_options_updated`) overwrite the mirror through the
 * store's delta fold, which pushes nothing back.
 *
 * Capability is discovered (ADR-0002): a knob is offered because the session
 * advertises it. The two exceptions are stated on their knobs.
 *
 * Everything a test needs is a parameter (`SessionConfigurationDeps`). The app
 * has one instance, made beside the chat store it writes to
 * (`sessionConfiguration` in `stores/chat-store.ts`), so that the store's
 * actions can call it without this file importing the store.
 */
import type { ChatSession, ClaudePermissionMode } from "@/types/agent";
import type { SessionKey } from "@/types/agents";
import { parseConfigOptions } from "./acp-config-options";
import type { agents } from "./agents-api";

/** What setting a knob asks of the agents backend (`agents-api.ts`). */
export type ConfigurationAgentsPort = Pick<
  typeof agents,
  "setMode" | "setModel" | "setEffort" | "setConfigOption"
>;

/** Where a pick is remembered for the next session. */
export interface ConfigurationPrefs {
  /** The last mode picked for an agent; `null` forgets it. */
  saveMode: (agentType: string, mode: string | null) => void;
  /** The last reasoning effort picked. One value, whatever the agent. */
  saveEffort: (effort: string) => void;
  /** The last value picked for one of an agent's options. */
  saveOption: (agentType: string, configId: string, value: boolean | string) => void;
}

/** One thing about a session the user can set. */
export interface Knob<V> {
  /** What it is called in a log line. */
  name: string;
  /**
   * Where the composer reads it, when it shows a pick before the agent has
   * answered. Absent for a knob whose only word is the agent's (`option`).
   */
  mirror?: {
    read: (session: ChatSession) => V | undefined;
    /** The user picked `value`. */
    pick: (session: ChatSession, value: V) => void;
    /** The agent refused the pick: back to `value`, the last one it holds
     *  (`undefined` when it held none the composer knew of). */
    restore: (session: ChatSession, value: V | undefined) => void;
  };
  /** Does this session offer the knob, and this value of it? A pick it does
   *  not offer is refused before anything is shown. */
  offers: (session: ChatSession, value: V) => boolean;
  push: (agents: ConfigurationAgentsPort, key: SessionKey, value: V) => Promise<void>;
  /** How a pick is remembered, once the agent has taken it or the bind has it
   *  to apply. Absent: it is not (`model`). */
  remember?: (prefs: ConfigurationPrefs, session: ChatSession, value: V) => void;
  /**
   * A pick made before the session is bound. `kept-for-bind`: shown and
   * remembered, and the bind puts the agent on it before the first prompt.
   * `refused`: nothing happens, because the knob only exists once the session
   * has advertised it.
   */
  unbound: "kept-for-bind" | "refused";
}

/**
 * Claude Code's permission mode. The list is Atlas's own
 * (`CLAUDE_PERMISSION_MODES`), not one the agent advertises, so this knob is
 * offered by agent id: the one place a mode is.
 */
const claudeMode: Knob<ClaudePermissionMode> = {
  name: "permission mode",
  mirror: {
    read: (session) => session.claudePermissionMode ?? "default",
    pick: (session, mode) => {
      session.claudePermissionMode = mode;
      session.claudePermissionModeExplicit = true;
      session.unrestoredModeId = undefined;
    },
    restore: (session, mode) => {
      session.claudePermissionMode = mode ?? "default";
    },
  },
  offers: (session) => session.agentType === "claude-code",
  push: (agents, key, mode) => agents.setMode(key, mode),
  // "default" means "defer to the CLI's own configured default": picking it
  // drops the remembered pick rather than storing it.
  remember: (prefs, _session, mode) =>
    prefs.saveMode("claude-code", mode === "default" ? null : mode),
  unbound: "kept-for-bind",
};

/**
 * The mode a plan approval selected. A decision about this session, so it is
 * not the user's pick: nothing is remembered and the explicit flag is left
 * alone.
 */
const planExitMode: Knob<ClaudePermissionMode> = {
  // The same name as `claudeMode`: they write the same pill, so their pushes
  // are one sequence (see `Flight`).
  name: claudeMode.name,
  mirror: {
    read: claudeMode.mirror!.read,
    pick: (session, mode) => {
      session.claudePermissionMode = mode;
      session.acpCurrentMode = mode;
    },
    restore: claudeMode.mirror!.restore,
  },
  offers: claudeMode.offers,
  push: claudeMode.push,
  unbound: "kept-for-bind",
};

/** A mode the agent advertises (`acpAvailableModes`). Remembered per agent. */
const acpMode: Knob<string> = {
  name: "mode",
  mirror: {
    read: (session) => session.acpCurrentMode,
    pick: (session, mode) => {
      session.acpCurrentMode = mode;
      session.acpModeExplicit = true;
      session.unrestoredModeId = undefined;
    },
    restore: (session, mode) => {
      session.acpCurrentMode = mode;
    },
  },
  // An id the agent did not advertise is rejected (`invalidParams`). An agent
  // that has advertised nothing yet is taken at its word.
  offers: (session, mode) => {
    const modes = session.acpAvailableModes ?? [];
    return !!mode && (modes.length === 0 || modes.some((m) => m.id === mode));
  },
  push: (agents, key, mode) => agents.setMode(key, mode),
  // Claude's modes have their own record, written by `claudeMode`.
  remember: (prefs, session, mode) => {
    if (session.agentType && session.agentType !== "claude-code") {
      prefs.saveMode(session.agentType, mode);
    }
  },
  unbound: "kept-for-bind",
};

/**
 * The model. Not remembered: a new session starts on the agent's own default.
 * Not checked against the advertised list either, which a tab that has just
 * switched agent does not have yet; the agent refuses an id it does not know.
 */
const model: Knob<string> = {
  name: "model",
  mirror: {
    read: (session) => session.acpCurrentModel,
    pick: (session, id) => {
      session.acpCurrentModel = id;
    },
    restore: (session, id) => {
      session.acpCurrentModel = id;
    },
  },
  offers: (_session, id) => !!id,
  push: (agents, key, id) => agents.setModel(key, id),
  unbound: "kept-for-bind",
};

/**
 * The native agent's reasoning effort. Offered by agent id, like the pill that
 * sets it: the engine does not advertise it as an option. Remembered once for
 * the app, not per agent.
 */
const effort: Knob<string> = {
  name: "reasoning effort",
  mirror: {
    read: (session) => session.nativeEffort,
    pick: (session, level) => {
      session.nativeEffort = level;
    },
    restore: (session, level) => {
      session.nativeEffort = level;
    },
  },
  offers: (session) => session.agentType === "atlas-agent",
  push: (agents, key, level) => agents.setEffort(key, level),
  remember: (prefs, _session, level) => prefs.saveEffort(level),
  unbound: "kept-for-bind",
};

/**
 * An option the agent advertises (`acpConfigOptions`). Nothing is shown until
 * the agent answers: its answer to the set is the confirmed list, which
 * arrives as a `config_options_updated` delta, so guessing in between would
 * only flicker the control when the agent disagrees.
 */
function option(configId: string): Knob<boolean | string> {
  return {
    name: `option "${configId}"`,
    // Only an option this session advertises, and only a value it takes.
    offers: (session, value) => {
      const knob = parseConfigOptions(session.acpConfigOptions).find((o) => o.id === configId);
      if (!knob) return false;
      if (knob.kind === "boolean") return typeof value === "boolean";
      return typeof value === "string" && knob.choices.some((choice) => choice.id === value);
    },
    push: (agents, key, value) => agents.setConfigOption(key, configId, value),
    remember: (prefs, session, value) => {
      if (session.agentType) prefs.saveOption(session.agentType, configId, value);
    },
    unbound: "refused",
  };
}

export const KNOBS = { claudeMode, planExitMode, acpMode, model, effort, option };

/**
 * `applied`: the agent took it. `kept-for-bind`: there is no session yet, the
 * bind will apply it. `refused`: the session does not offer it, or the agent
 * said no.
 */
export type PickOutcome = "applied" | "kept-for-bind" | "refused";

export interface SessionConfigurationDeps {
  agents: ConfigurationAgentsPort;
  /** The chat store's sessions: read one, or write to one's mirror. */
  sessions: {
    get: (tabId: string) => ChatSession | undefined;
    update: (tabId: string, recipe: (session: ChatSession) => void) => void;
  };
  prefs: ConfigurationPrefs;
  /** Where a refusal is said, in the agent's words. */
  report: { refused: (message: string) => void };
}

export interface SessionConfiguration {
  /** The user picked `value` for `knob` on `tabId`'s session. The composer
   *  shows it before this returns; the answer says how it ended. */
  pick<V>(tabId: string, knob: Knob<V>, value: V): Promise<PickOutcome>;
  /**
   * Put the agent back on a value the tab already holds, once its session is
   * bound. Not a pick: nothing is remembered, the user's flags are left alone,
   * and a refusal is only logged, as the bind's own pushes are.
   */
  reapply<V>(tabId: string, knob: Knob<V>, value: V): Promise<void>;
  /** Forget what is in flight. For tests that share the app's instance. */
  reset(): void;
}

const keyOf = (session: ChatSession): SessionKey | null =>
  session.acpAgentId && session.acpSessionId
    ? { agent_id: session.acpAgentId, session_id: session.acpSessionId }
    : null;

/**
 * The picks of one knob on one tab that the agent has not answered yet.
 *
 * A refusal has to put the composer back on what the agent HOLDS, and with
 * two picks out that is not "what showed before this pick": the pick before
 * may itself be refused. So the value is taken once, when the first pick goes
 * out (nothing was in flight, the composer showed the agent's), and moves only
 * when the agent accepts one.
 */
interface Flight {
  /** The latest pick's number. Only that pick's refusal touches the composer. */
  latest: number;
  /** Pushes not yet answered. At zero the entry is dropped. */
  out: number;
  /** What the agent holds, and the pick that put it there (0: none of these). */
  held: unknown;
  heldBy: number;
}

export function createSessionConfiguration(deps: SessionConfigurationDeps): SessionConfiguration {
  const flights = new Map<string, Flight>();

  async function pick<V>(tabId: string, knob: Knob<V>, value: V): Promise<PickOutcome> {
    const session = deps.sessions.get(tabId);
    if (!session) return "refused";
    // Not offered, not picked: nothing is shown, pushed or remembered. The
    // composer only lists what the session offers, so this is the guard for
    // every other caller (a shortcut, a programmatic pick, a stale menu).
    if (!knob.offers(session, value)) return "refused";
    const key = keyOf(session);
    if (!key && knob.unbound === "refused") return "refused";

    const { mirror } = knob;
    const shown = mirror?.read(session);
    if (mirror) deps.sessions.update(tabId, (s) => mirror.pick(s, value));
    if (!key) {
      knob.remember?.(deps.prefs, session, value);
      return "kept-for-bind";
    }

    const flightKey = `${tabId}\u0000${knob.name}`;
    const flight = flights.get(flightKey) ?? { latest: 0, out: 0, held: shown, heldBy: 0 };
    flights.set(flightKey, flight);
    const mine = ++flight.latest;
    flight.out += 1;
    try {
      await knob.push(deps.agents, key, value);
      // Pushes reach the agent in order, so the latest accepted one is what
      // it holds, whichever answer came back first.
      if (mine > flight.heldBy) {
        flight.held = value;
        flight.heldBy = mine;
        // Remembered only now: a pick the agent refused would otherwise be
        // where the next session starts.
        knob.remember?.(deps.prefs, session, value);
      }
      return "applied";
    } catch (err) {
      console.warn(`setting the ${knob.name} failed:`, err);
      // The pick is already showing. Leaving it there is the composer lying:
      // the native agent refuses a mid-turn mode switch precisely because the
      // running turn keeps the permissions it started with (#61). Roll it
      // back and say why, unless something newer is showing: a later pick, or
      // a change the agent reported.
      if (mirror && mine === flight.latest) {
        const held = flight.held as V | undefined;
        deps.sessions.update(tabId, (s) => {
          if (Object.is(mirror.read(s), value)) mirror.restore(s, held);
        });
      }
      deps.report.refused(typeof err === "string" ? err : String(err));
      return "refused";
    } finally {
      flight.out -= 1;
      if (flight.out === 0 && flights.get(flightKey) === flight) flights.delete(flightKey);
    }
  }

  async function reapply<V>(tabId: string, knob: Knob<V>, value: V): Promise<void> {
    const session = deps.sessions.get(tabId);
    if (!session || !knob.offers(session, value)) return;
    const { mirror } = knob;
    if (mirror) deps.sessions.update(tabId, (s) => mirror.restore(s, value));
    const key = keyOf(session);
    if (!key) return;
    try {
      await knob.push(deps.agents, key, value);
    } catch (err) {
      console.warn(`re-applying the ${knob.name} failed:`, err);
    }
  }

  return {
    pick,
    reapply,
    reset() {
      flights.clear();
    },
  };
}
