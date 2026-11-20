// zustand's `immer` middleware, on an Immer instance that does not freeze.
//
// For a store whose state holds one large, long-lived array that every update
// touches the end of: the chat store's `messages`, which a long session holds
// 3,000–12,000 of and a streaming turn updates per frame. Immer's auto-freeze
// finishes each `set` by deep-freezing what changed, and an array that changed
// is frozen whole: `Object.freeze` over every slot, then a frozen check per
// element. JavaScriptCore (both WebKit webviews) pays that per element, so it
// grows with the session, not with the update: 1.8 ms per streamed batch at
// 2,900 messages and 7 ms at 12,000, measured with the real store in Bun's JSC.
// Without the freeze the same batch is a shallow copy of the array, tens of
// microseconds.
//
// What is given up is Immer's guard against mutating state outside a recipe,
// which turns a stray write into a TypeError. Every write still goes through
// `set` and a draft; the store's tests run on this same instance.
//
// Scoped to the stores that opt in. Immer's global `setAutoFreeze` would turn
// the guard off for every store in the app.

import { Immer } from "immer";
import type { StateCreator, StoreApi } from "zustand";
import type { immer } from "zustand/middleware/immer";

const unfrozen = new Immer({ autoFreeze: false });

type Updater = (state: unknown) => unknown;

function immerUnfrozenImpl(initializer: StateCreator<object>): StateCreator<object> {
  return (set, get, store: StoreApi<object>) => {
    store.setState = (updater, replace, ...rest: unknown[]) => {
      const next = typeof updater === "function" ? unfrozen.produce(updater as Updater) : updater;
      return (set as (...args: unknown[]) => void)(next, replace, ...rest);
    };
    return initializer(store.setState, get, store);
  };
}

/** Drop-in for `immer` from `zustand/middleware/immer`, without auto-freeze. */
export const immerUnfrozen = immerUnfrozenImpl as unknown as typeof immer;
