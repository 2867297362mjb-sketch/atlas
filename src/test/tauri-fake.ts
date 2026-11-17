// The one fake of the Tauri seam for vitest: `invoke` answers from a handler
// table, `listen` registers a real subscriber, and a test can `emit`.
//
// A test file opts in by pointing Tauri's two modules at it, then drives it
// through `tauri`:
//
//   vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
//   vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
//   import { tauri } from "@/test/tauri-fake";
//
//   beforeEach(() => tauri.reset());
//
//   tauri.handle({ git_tags: () => ["v1"] });              // typed per command
//   await tauri.emit("atlas:git-changed", { project });    // subscribers run
//   expect(tauri.calls("git_tags")).toEqual([{ cmd: "git_tags", args: { repoPath } }]);
//
// Opt-in per file, not a setup file: `vitest.config.ts` has none on purpose,
// and most test files never touch Tauri. Vitest gives every test file its own
// module registry, so this module's state cannot leak from one file into
// another; inside a file, `tauri.reset()` is the clean slate. It drops every
// subscriber, so a file testing code that subscribes once per module lifetime
// (a store's `ensureListener`) clears only the calls: `tauri.invoke.mockClear()`.
//
// Answer order for a command, the mock backend's rule (`backend.ts`):
//   1. a handler the test gave `handle` / `handleRaw`
//   2. the scenario `useScenario` loaded, if any (its commands, then the base)
//   3. `null`, or a rejection under `strict()`
//
// The handler types are the mock backend's (`src/dev/mock-backend/types.ts`),
// so a test's answer is checked against what the frontend's `invoke<T>` reads,
// and `useScenario` hands a test the same fixtures `bun run dev` runs on. Those
// fixtures are imported only inside `useScenario`: a test that never asks for
// one never evaluates them.
//
// Never imported by app code (`tauri-fake.test.ts` checks), so it is never in
// the bundle.

import { vi, type Mock } from "vitest";
import type {
  MockArgs,
  MockHandler,
  MockHandlers,
  MockResponses,
  TypedHandlers,
} from "@/dev/mock-backend/types";

/** What Tauri hands a `listen` callback. */
interface TauriEvent {
  event: string;
  id: number;
  payload: unknown;
}
type Subscriber = (event: TauriEvent) => unknown;

/** One `invoke(cmd, args)` the app made. `args` is `{}` when it passed none. */
export interface TauriCall {
  cmd: string;
  args: MockArgs;
}

let handlers: MockHandlers = {};
let scenario: MockHandlers = {};
let rejectUnhandled = false;
let nextEventId = 1;
const subscribers = new Map<string, Set<Subscriber>>();

// Declared `async` so a handler that throws rejects, as a failed command does.
async function answer(cmd: string, args?: MockArgs): Promise<unknown> {
  const handler: MockHandler | undefined = handlers[cmd] ?? scenario[cmd];
  if (handler) return handler(args ?? {});
  if (rejectUnhandled) throw new Error(`[tauri-fake] no handler for "${cmd}"`);
  return null;
}

function subscribe(channel: string, callback: Subscriber): () => void {
  const set = subscribers.get(channel) ?? new Set();
  subscribers.set(channel, set);
  set.add(callback);
  return () => {
    set.delete(callback);
  };
}

// Subscribers are called before this returns; the promise is for whatever
// async work they started.
async function deliver(channel: string, payload?: unknown): Promise<void> {
  const event: TauriEvent = { event: channel, id: nextEventId++, payload };
  await Promise.all([...(subscribers.get(channel) ?? [])].map((callback) => callback(event)));
}

// The spies are what the mocked modules export, so a test can still write
// `expect(invoke).toHaveBeenCalledWith(…)` or, for a one-off, `mockResolvedValueOnce`.
// `mockReset()` puts the implementations below back.
// Untyped like `vi.fn()`, as `invoke<T>` is: the caller names the args and the answer.
const invoke: Mock = vi.fn(answer);
const listen = vi.fn(async (channel: string, callback: Subscriber) => subscribe(channel, callback));
const once = vi.fn(async (channel: string, callback: Subscriber) => {
  const unlisten = subscribe(channel, (event) => {
    unlisten();
    return callback(event);
  });
  return unlisten;
});
const emit = vi.fn(deliver);

/** A streaming command's channel: the handler finds it in its args and calls `onmessage`. */
class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};
}

/** `@tauri-apps/api/core`, as far as the app imports it. */
export const core = {
  invoke,
  Channel,
  convertFileSrc: (path: string) => path,
  isTauri: () => false,
};

/** `@tauri-apps/api/event`, as far as the app imports it (plus `once`). */
export const event = { listen, once, emit };

export const tauri = {
  /** The `invoke` the app calls, as a spy. */
  invoke,

  /**
   * Answer commands, on top of whatever is already handled. Typed like a mock
   * backend fixture: the answer must be what the frontend's `invoke<T>` reads.
   */
  handle(commands: Partial<TypedHandlers<MockResponses>>): void {
    handlers = { ...handlers, ...(commands as MockHandlers) };
  },

  /** `handle` for a command no fixture declares a response type for yet. Untyped, so prefer `handle`. */
  handleRaw(commands: MockHandlers): void {
    handlers = { ...handlers, ...commands };
  },

  /**
   * Answer everything else as the mock backend does under `bun run dev`: its
   * base handlers, under the named scenario's own when one is named. The
   * fixtures keep their state in module scope, so what one test mutates the
   * next test in the file sees.
   */
  async useScenario(name?: string): Promise<void> {
    const { baseHandlers } = await import("@/dev/mock-backend/scenarios/base");
    if (name === undefined) {
      scenario = baseHandlers;
      return;
    }
    const { scenarios } = await import("@/dev/mock-backend/scenarios");
    const found = scenarios[name];
    if (!found) throw new Error(`[tauri-fake] unknown scenario "${name}"`);
    scenario = { ...baseHandlers, ...found.rawCommands, ...(found.commands as MockHandlers) };
    found.init?.();
  },

  /** Reject a command nothing handles, instead of resolving `null`. */
  strict(): void {
    rejectUnhandled = true;
  },

  /** Every `invoke` so far, in order; or only those of one command. */
  calls(cmd?: string): TauriCall[] {
    const all = invoke.mock.calls.map(([name, args]): TauriCall => ({
      cmd: name,
      args: args ?? {},
    }));
    return cmd === undefined ? all : all.filter((call) => call.cmd === cmd);
  },

  /**
   * Deliver an event as the backend would: each subscriber gets `{ payload }`.
   * They are called before this returns; await it to let their async work settle.
   */
  emit(channel: string, payload?: unknown): Promise<void> {
    return deliver(channel, payload);
  },

  /** How many subscribers a channel has, to check that a cleanup unlistened. */
  listenerCount(channel: string): number {
    return subscribers.get(channel)?.size ?? 0;
  },

  /** Back to nothing: no handlers, no scenario, no subscribers, no recorded calls. */
  reset(): void {
    handlers = {};
    scenario = {};
    rejectUnhandled = false;
    subscribers.clear();
    for (const spy of [invoke, listen, once, emit]) spy.mockReset();
  },
};
