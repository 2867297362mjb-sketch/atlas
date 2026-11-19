// @vitest-environment happy-dom
// The memory graph's canvas: a renderer that will not start says so, with
// pixi's reason, instead of leaving the ruler over an empty canvas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const pixi = vi.hoisted(() => ({ init: (): Promise<void> => Promise.resolve() }));

vi.mock("pixi.js", () => ({
  Application: class {
    init() {
      return pixi.init();
    }
    destroy() {}
  },
}));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("../../lib/memory-graph-scene", () => ({ buildMemoryScene: () => () => {} }));

import { MemoryGraphCanvasView } from "./memory-graph-canvas-view";

/** What pixi 8 throws where the CSP refuses `eval` and no polyfill is in. */
const CSP_REFUSAL =
  "Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module to enable support.";

/** The view measures itself before it mounts the scene; report a real size. */
class SizedObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function renderCanvas() {
  return render(
    <MemoryGraphCanvasView
      graph={{
        nodes: [
          {
            id: "claude:a.md",
            title: "A",
            summary: "A",
            kind: "fact",
            source: "claude",
            snippet: "",
            degree: 0,
            timestampMs: 0,
          },
        ],
        edges: [],
      }}
      initialLayout={{ positions: {} }}
      selectedId={null}
      matchedIds={new Set()}
      cutoffMs={null}
      onSelect={() => {}}
      onActivate={() => {}}
      onLayoutSave={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", SizedObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  pixi.init = () => Promise.resolve();
});

describe("MemoryGraphCanvasView", () => {
  it("says the graph could not be drawn, and why, when the renderer will not start", async () => {
    pixi.init = () => Promise.reject(new Error(CSP_REFUSAL));
    renderCanvas();
    expect(await screen.findByText("Couldn't draw the graph")).toBeTruthy();
    expect(screen.getByText(CSP_REFUSAL)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Fix with agent/ })).toBeTruthy();
  });

  it("shows no error when the renderer starts", async () => {
    const started = vi.fn(() => Promise.resolve());
    pixi.init = started;
    renderCanvas();
    await waitFor(() => expect(started).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText("Couldn't draw the graph")).toBeNull();
  });
});
