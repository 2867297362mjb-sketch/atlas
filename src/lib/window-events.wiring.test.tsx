// @vitest-environment happy-dom
//
// Two of the busiest window events, end to end through real modules: the
// module that emits, the component or module that listens, and the next seam
// after the listener (an `invoke`, a store). `window-events.test.tsx` pins the
// helpers; this pins that the app's own emitters and listeners still meet
// through them. (`atlas:chat-send` has the same test beside its listener, in
// `features/chat/hooks/send-wiring.test.tsx`.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

/** The native window, as much of it as focus tracking uses. */
const nativeWindow = vi.hoisted(() => {
  let onFocus: ((event: { payload: boolean }) => void) | null = null;
  return {
    api: {
      isFocused: async () => false,
      onFocusChanged: async (cb: (event: { payload: boolean }) => void) => {
        onFocus = cb;
        return () => {
          onFocus = null;
        };
      },
    },
    /** The OS reports the window gained (`true`) or lost focus. */
    focusChanged: (focused: boolean) => onFocus?.({ payload: focused }),
    listening: () => onFocus !== null,
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow.api }));

import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { BUILTIN_THEMES } from "@/dev/mock-backend/fixtures/builtin-themes";
import { MediaViewer } from "@/features/media/components/media-viewer";
import { applyTheme } from "@/features/theme/apply-theme";
import { onThemeApplied, useThemeVersion } from "@/features/theme/theme-values";
import { initWindowFocusTracking } from "./window-focus";

beforeEach(() => tauri.reset());
afterEach(() => cleanup());

describe("the window-active wake", () => {
  const mtimeReads = () => tauri.calls("file_mtime_ms").length;

  it("the focus tracker's wake reaches a mounted viewer, which re-reads its file", async () => {
    tauri.handleRaw({ file_mtime_ms: () => 1 });
    const stopTracking = initWindowFocusTracking();
    await waitFor(() => expect(nativeWindow.listening()).toBe(true));
    const { unmount } = render(<MediaViewer filePath="/repo/clip.mp4" />);
    await waitFor(() => expect(mtimeReads()).toBe(1));

    // The focus rising edge.
    await act(async () => nativeWindow.focusChanged(true));
    expect(mtimeReads()).toBe(2);
    // Already focused: not an edge, so no wake.
    await act(async () => nativeWindow.focusChanged(true));
    expect(mtimeReads()).toBe(2);
    // The page becoming visible wakes it too.
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(mtimeReads()).toBe(3);

    // An unmounted viewer no longer listens.
    unmount();
    await act(async () => {
      nativeWindow.focusChanged(false);
      nativeWindow.focusChanged(true);
    });
    expect(mtimeReads()).toBe(3);
    stopTracking();
  });
});

describe("the theme-applied signal", () => {
  it("applying a theme reaches the imperative subscribers and re-renders the readers", () => {
    const theme = BUILTIN_THEMES[0];
    const repaint = vi.fn();
    const off = onThemeApplied(repaint);
    const version = renderHook(() => useThemeVersion());
    const before = version.result.current;

    act(() => void applyTheme(theme, "dark"));
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(version.result.current).toBe(before + 1);

    off();
    act(() => void applyTheme(theme, "light"));
    expect(repaint).toHaveBeenCalledTimes(1);
    expect(version.result.current).toBe(before + 2);
  });
});
