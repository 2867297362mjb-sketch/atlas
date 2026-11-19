// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RenderBoundary } from "./render-boundary";

function Throws({ when }: { when: boolean }) {
  if (when) throw new Error("a row the agent sent");
  return <span>drawn</span>;
}

afterEach(cleanup);

describe("RenderBoundary", () => {
  it("draws the fallback in place of what threw, and only there", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <RenderBoundary name="t" fallback={<span>could not show</span>}>
          <Throws when />
        </RenderBoundary>
        <span>the rest of the window</span>
      </div>,
    );
    expect(screen.getByText("could not show")).toBeTruthy();
    expect(screen.getByText("the rest of the window")).toBeTruthy();
  });

  it("tries again when its reset key changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <RenderBoundary name="t" resetKey={1} fallback={<span>could not show</span>}>
        <Throws when />
      </RenderBoundary>,
    );
    rerender(
      <RenderBoundary name="t" resetKey={2} fallback={<span>could not show</span>}>
        <Throws when={false} />
      </RenderBoundary>,
    );
    expect(screen.getByText("drawn")).toBeTruthy();
  });
});
