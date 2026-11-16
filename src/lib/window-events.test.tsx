// @vitest-environment happy-dom
//
// The window-event helpers through their interface: what an emit delivers,
// what an unsubscribe stops, and what the hook does across a component's
// life. The names used are real ones from the map; nothing here cares what
// they mean.

import { StrictMode, useState } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitWindowEvent, onWindowEvent, useWindowEvent } from "./window-events";

const offs: Array<() => void> = [];
/** Subscribe for the length of one test. */
const during = (off: () => void) => void offs.push(off);

afterEach(() => {
  cleanup();
  for (const off of offs.splice(0)) off();
});

describe("emitWindowEvent and onWindowEvent", () => {
  it("delivers the detail to every listener, before the emit returns", () => {
    const first = vi.fn();
    const second = vi.fn();
    during(onWindowEvent("atlas:chat-focus", first));
    during(onWindowEvent("atlas:chat-focus", second));

    emitWindowEvent("atlas:chat-focus", { tabId: "t1" });

    // Synchronous: no tick between the emit and the assertions.
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toEqual({ tabId: "t1" });
    expect(second.mock.calls[0][0]).toEqual({ tabId: "t1" });
  });

  it("hands the listener the event itself, under the event's own name", () => {
    const seen: Event[] = [];
    during(onWindowEvent("atlas:composer-menu-open", (_detail, event) => void seen.push(event)));
    emitWindowEvent("atlas:composer-menu-open", "add");
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("atlas:composer-menu-open");
    expect(seen[0]).toBeInstanceOf(CustomEvent);
  });

  it("is a plain DOM event: a native listener hears an emit, and a native dispatch reaches a listener", () => {
    // `index.html` listens for `atlas:app-ready` natively, because it runs
    // before any module does. This file is the one place outside the map
    // allowed to do the same (`tests/window-event-contract.test.ts`).
    const native = vi.fn();
    window.addEventListener("atlas:app-ready", native);
    emitWindowEvent("atlas:app-ready");
    window.removeEventListener("atlas:app-ready", native);
    expect(native).toHaveBeenCalledTimes(1);

    const helper = vi.fn();
    during(onWindowEvent("atlas:app-ready", helper));
    window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    expect(helper).toHaveBeenCalledTimes(1);
  });

  it("reaches only the listeners of that event", () => {
    const focus = vi.fn();
    const stop = vi.fn();
    during(onWindowEvent("atlas:chat-focus", focus));
    during(onWindowEvent("atlas:chat-stop", stop));
    emitWindowEvent("atlas:chat-stop", { tabId: "t1" });
    expect(focus).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("emits an event with no payload with no second argument", () => {
    const heard = vi.fn();
    during(onWindowEvent("atlas:window-active", heard));
    emitWindowEvent("atlas:window-active");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stops delivering to a listener once it unsubscribes, and only to that one", () => {
    const gone = vi.fn();
    const stays = vi.fn();
    const off = onWindowEvent("atlas:plan-saved", gone);
    during(onWindowEvent("atlas:plan-saved", stays));

    emitWindowEvent("atlas:plan-saved");
    off();
    emitWindowEvent("atlas:plan-saved");
    // Unsubscribing twice is harmless.
    off();

    expect(gone).toHaveBeenCalledTimes(1);
    expect(stays).toHaveBeenCalledTimes(2);
  });

  it("subscribes the same handler twice as two listeners, each with its own unsubscribe", () => {
    const handler = vi.fn();
    const offFirst = onWindowEvent("atlas:plan-saved", handler);
    during(onWindowEvent("atlas:plan-saved", handler));
    emitWindowEvent("atlas:plan-saved");
    expect(handler).toHaveBeenCalledTimes(2);
    offFirst();
    emitWindowEvent("atlas:plan-saved");
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("lets a listener unsubscribe itself from inside its own call", () => {
    const heard = vi.fn();
    const off = onWindowEvent("atlas:app-ready", () => {
      off();
      heard();
    });
    emitWindowEvent("atlas:app-ready");
    emitWindowEvent("atlas:app-ready");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering after a listener throws, as dispatchEvent does", () => {
    // A browser reports a listener's exception to the window and goes on to
    // the next listener. Vitest turns that off in happy-dom, so that a test's
    // own exception surfaces; this test is about that behaviour, so it turns
    // it back on. The helpers add nothing of their own here: the isolation is
    // `dispatchEvent`'s, and they must not get in its way.
    const settings = (
      window as unknown as {
        happyDOM: { settings: { errorCapture: string; disableErrorCapturing: boolean } };
      }
    ).happyDOM.settings;
    const before = { ...settings };
    settings.errorCapture = "tryAndCatch";
    settings.disableErrorCapturing = false;
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    try {
      during(
        onWindowEvent("atlas:repo-cloned", () => {
          throw new Error("listener broke");
        }),
      );
      during(onWindowEvent("atlas:repo-cloned", after));

      expect(() => emitWindowEvent("atlas:repo-cloned")).not.toThrow();
      expect(after).toHaveBeenCalledTimes(1);
      expect(reported.map((e) => (e as Error).message)).toEqual(["listener broke"]);
    } finally {
      settings.errorCapture = before.errorCapture;
      settings.disableErrorCapturing = before.disableErrorCapturing;
      window.removeEventListener("error", onError);
      quiet.mockRestore();
    }
  });
});

describe("a cancelable emit", () => {
  it("returns true when nobody is listening", () => {
    expect(emitWindowEvent("atlas:chat-send", { text: "hi" }, { cancelable: true })).toBe(true);
  });

  it("returns true when listeners heard it but none marked it handled", () => {
    during(onWindowEvent("atlas:chat-send", () => {}));
    expect(emitWindowEvent("atlas:chat-send", { text: "hi" }, { cancelable: true })).toBe(true);
  });

  it("returns false once a listener calls preventDefault", () => {
    during(onWindowEvent("atlas:chat-send", (_detail, event) => event.preventDefault()));
    expect(emitWindowEvent("atlas:chat-send", { text: "hi" }, { cancelable: true })).toBe(false);
  });

  it("is not cancelable unless asked: preventDefault on a plain emit changes nothing", () => {
    during(onWindowEvent("atlas:chat-send", (_detail, event) => event.preventDefault()));
    expect(emitWindowEvent("atlas:chat-send", { text: "hi" })).toBe(true);
  });
});

describe("useWindowEvent", () => {
  it("listens from mount to unmount", () => {
    const heard = vi.fn();
    const { unmount } = renderHook(() => useWindowEvent("atlas:chat-stop", heard));

    emitWindowEvent("atlas:chat-stop", { tabId: "t1" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toEqual({ tabId: "t1" });

    unmount();
    emitWindowEvent("atlas:chat-stop", { tabId: "t1" });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("leaves one listener after StrictMode's double mount", () => {
    const heard = vi.fn();
    const { unmount } = renderHook(() => useWindowEvent("atlas:plan-saved", heard), {
      wrapper: StrictMode,
    });
    emitWindowEvent("atlas:plan-saved");
    expect(heard).toHaveBeenCalledTimes(1);
    unmount();
    emitWindowEvent("atlas:plan-saved");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("calls the latest render's handler, without the caller memoising it", () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ tabId }: { tabId: string }) =>
        useWindowEvent("atlas:chat-focus", (detail) => {
          if (detail.tabId === tabId) seen.push(tabId);
        }),
      { initialProps: { tabId: "a" } },
    );
    emitWindowEvent("atlas:chat-focus", { tabId: "a" });
    rerender({ tabId: "b" });
    emitWindowEvent("atlas:chat-focus", { tabId: "a" });
    emitWindowEvent("atlas:chat-focus", { tabId: "b" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("lets the handler set state", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      useWindowEvent("atlas:plan-saved", () => setCount((c) => c + 1));
      return <output>{count}</output>;
    }
    const { container } = render(<Counter />);
    act(() => void emitWindowEvent("atlas:plan-saved"));
    act(() => void emitWindowEvent("atlas:plan-saved"));
    expect(container.textContent).toBe("2");
  });

  it("each mounted component listens for itself", () => {
    const a = vi.fn();
    const b = vi.fn();
    const first = renderHook(() => useWindowEvent("atlas:plan-saved", a));
    renderHook(() => useWindowEvent("atlas:plan-saved", b));
    first.unmount();
    emitWindowEvent("atlas:plan-saved");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
