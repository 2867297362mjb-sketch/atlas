// @vitest-environment happy-dom
// The knowledge graph's canvas: a renderer that will not start says so, with
// pixi's reason, instead of leaving the ruler over an empty canvas.
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../../lib/knowledge-graph-scene", () => ({ buildKnowledgeScene: () => () => {} }));

import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";

/** What pixi 8 throws where the CSP refuses `eval` and no polyfill is in. */
const CSP_REFUSAL =
  "Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module to enable support.";

function renderCanvas() {
  return render(
    <KnowledgeGraphCanvas
      graph={{ nodes: [{ id: "a", title: "A", inDegree: 0, outDegree: 0 }], edges: [] }}
      width={400}
      height={300}
      selectedId={null}
      onSelect={() => {}}
      onActivate={() => {}}
      initialLayout={{ positions: {} }}
      onLayoutChange={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  pixi.init = () => Promise.resolve();
});

describe("KnowledgeGraphCanvas", () => {
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
