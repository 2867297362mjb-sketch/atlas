// @vitest-environment happy-dom
//
// The transcript's window, through the hook the transcript mounts: which rows
// are in the DOM, and where the reader is left when that set changes.
//
// happy-dom lays nothing out, so the geometry is supplied: every row is
// `ROW_H` tall, a row's `offsetTop` is its position among the mounted rows,
// and the scroller clamps `scrollTop` the way a browser does. That is enough
// for every rule here, because the hook only ever reads `scrollTop`,
// `offsetTop` and the two heights. The ResizeObserver is stood in for the same
// way: `settle()` is its report (on first observing, and whenever the mounted
// rows change the content's height) followed by the frame it schedules.
//
// The numbers are restated rather than imported: each is a decision about what
// the reader waits through, and changing one should mean changing it twice.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { RowKind, TOP_BLUR_RAMP, type Row } from "@tryatlas/design/session";
import { markScrollHot } from "@/lib/scroll-hot";
import {
  SCROLL_BOTTOM,
  useTranscriptWindow,
  type TranscriptWindow,
  type TranscriptWindowInput,
} from "./use-transcript-window";

const WINDOW_INITIAL = 80;
const WINDOW_CHUNK = 40;
const IDLE_CHUNK = 120;
const MAX_IDLE_FILL = 4000;
/** `use-transcript-scroll.ts`: how near the top a scroll grows the window. */
const GROW_MARGIN = 2200;
const ANCHOR_GAP = 24;
const STICKY_SETTLE_MS = 4000;

const ROW_H = 100;
const VIEW_H = 600;

// ── Geometry ────────────────────────────────────────────────────────────────

const scrollTops = new WeakMap<Element, number>();
const isScroller = (el: Element) => el.hasAttribute("data-scroller");
const scrollHeightOf = (el: Element) => el.querySelectorAll("[data-row-id]").length * ROW_H;
const GEOMETRY = ["offsetTop", "scrollHeight", "clientHeight", "scrollTop"] as const;

function installGeometry() {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const siblings = this.parentElement?.children;
      return siblings ? Array.prototype.indexOf.call(siblings, this) * ROW_H : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? scrollHeightOf(this) : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? VIEW_H : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, scrollHeightOf(this) - VIEW_H);
      scrollTops.set(this, Math.min(Math.max(0, value), max));
    },
  });
}
function removeGeometry() {
  for (const prop of GEOMETRY) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
}

// ── The clocks the hook runs on ─────────────────────────────────────────────

let frames: FrameRequestCallback[] = [];
let idles: { cb: () => void; timeout: number | undefined }[] = [];
let resizes: ResizeObserverCallback[] = [];
let now = 0;
// `scroll-hot.ts` keeps "the reader is mid-gesture until T" in module state,
// so the clock only ever moves forward, across tests too.
let clock = 1_000_000;

const flushFrames = () =>
  act(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
/** Run one idle slice, if one was asked for. */
const idleSlice = () =>
  act(() => {
    idles.shift()?.cb();
  });
const settle = () =>
  act(() => {
    for (const cb of resizes) cb([], {} as ResizeObserver);
    for (const cb of frames.splice(0)) cb(0);
  });
/** The reader's gesture has gone quiet (`markScrollHot` holds for 160 ms). */
const rest = () => {
  now += 200;
};

beforeEach(() => {
  frames = [];
  idles = [];
  resizes = [];
  now = clock += 100_000;
  installGeometry();
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        resizes.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Queued, not synchronous: see `use-transcript-scroll.test.ts`.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("requestIdleCallback", (cb: () => void, opts?: { timeout?: number }) => {
    idles.push({ cb, timeout: opts?.timeout });
    return idles.length;
  });
  vi.stubGlobal("cancelIdleCallback", () => {
    idles = [];
  });
});
afterEach(() => {
  cleanup();
  removeGeometry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── Rows ────────────────────────────────────────────────────────────────────

const row = (id: string, kind: number, text = "") => ({ id, kind, text }) as unknown as Row;

/** `count` rows, a prompt then its answer, so the last user turn is the
 *  second-to-last row. `prefix` keeps two sessions' ids apart. */
function thread(count: number, prefix = "r"): Row[] {
  return Array.from({ length: count }, (_, i) =>
    row(`${prefix}${i}`, i % 2 === 0 ? RowKind.User : RowKind.Prose, "…"),
  );
}
/** One prompt, then `count - 1` rows of answer. */
function longAnswer(count: number, prefix = "a"): Row[] {
  return Array.from({ length: count }, (_, i) =>
    row(`${prefix}${i}`, i === 0 ? RowKind.User : RowKind.Prose, "…"),
  );
}

// ── The transcript, as far as the window is concerned ───────────────────────

type Props = Omit<TranscriptWindowInput, "scrollRef" | "contentRef">;
/** What the hook last returned. */
let win: TranscriptWindow;
const capture = (latest: TranscriptWindow) => {
  win = latest;
};

function Transcript(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const latest = useTranscriptWindow({ ...props, scrollRef, contentRef });
  capture(latest);
  return (
    <div ref={scrollRef} data-scroller="">
      <div ref={contentRef}>
        {props.rows.slice(latest.safeStart).map((r) => (
          <div key={r.id} data-row-id={r.id}>
            <div />
          </div>
        ))}
      </div>
    </div>
  );
}

// The saved-scroll cache is module state with no reset: a key per test.
let keySeq = 0;
const freshKey = () => `tab-1:sess-${++keySeq}`;

/** `settled: false` stops at the commit, before the observer has reported. */
async function mount(
  initial: Partial<Props> & Pick<Props, "rows">,
  opts: { settled?: boolean } = {},
) {
  let props: Props = {
    live: true,
    cacheKey: freshKey(),
    topInset: 0,
    working: false,
    ...initial,
  };
  const view = render(<Transcript {...props} />);
  const scroller = view.container.querySelector<HTMLElement>("[data-scroller]")!;
  if (opts.settled !== false) await settle();
  return {
    scroller,
    props: () => props,
    async update(patch: Partial<Props>, o: { settled?: boolean } = {}) {
      const before = scroller.scrollHeight;
      props = { ...props, ...patch };
      view.rerender(<Transcript {...props} />);
      if (o.settled !== false && scroller.scrollHeight !== before) await settle();
    },
    unmount: view.unmount,
    mounted: () =>
      [...scroller.querySelectorAll("[data-row-id]")].map((n) => n.getAttribute("data-row-id")),
    /** The reader scrolls to `top`, and the frame it schedules runs. */
    async scrollTo(top: number) {
      // A wheel, as a reader's scroll is: it also takes the landed row out of
      // the hold (programmatic scrolls do not).
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = top;
      act(() => win.onScroll());
      await flushFrames();
    },
    /** Where a row sits, in pixels below the viewport's top edge. */
    offsetOf(rowId: string) {
      const node = scroller.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`)!;
      return node.offsetTop - scroller.scrollTop;
    },
    maxScroll: () => scroller.scrollHeight - VIEW_H,
  };
}

describe("the window a session opens with", () => {
  it("mounts the last 80 rows of a longer thread, and all of a shorter one", async () => {
    expect((await mount({ rows: thread(300) })).mounted()).toHaveLength(WINDOW_INITIAL);
    expect(win.safeStart).toBe(300 - WINDOW_INITIAL);
    cleanup();

    await mount({ rows: thread(WINDOW_INITIAL) });
    expect(win.safeStart).toBe(0);
    cleanup();

    await mount({ rows: thread(12) });
    expect(win.safeStart).toBe(0);
  });

  it("lands on the last user turn, 24px below the top edge", async () => {
    // The prompt (a0) heads a long answer: it is brought to the top.
    const t = await mount({ rows: [...thread(60, "q"), ...longAnswer(60)] });
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP);
    expect(win.more).toBe(true);

    cleanup();
    // A prompt near the end cannot be brought that high: the bottom is as far
    // as the scroller goes, and the prompt is on screen there.
    const short = await mount({ rows: thread(100) });
    expect(short.scroller.scrollTop).toBe(short.maxScroll());
    expect(win.more).toBe(false);
  });

  it("as found: the landing is the first resize report's, not the commit's", async () => {
    // In the commit the live-edge follow (declared after the landing, and
    // starting out "at the end") writes the bottom over it. What puts the
    // prompt back is the hold on the landed row, the first time the observer
    // reports — which a browser does in the same frame, before paint.
    const t = await mount({ rows: [...thread(60, "q"), ...longAnswer(60)] }, { settled: false });
    expect(t.scroller.scrollTop).toBe(t.maxScroll());
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP);
  });

  it("clears the floating header and its blur band when there is one", async () => {
    const t = await mount({ rows: [...thread(60, "q"), ...longAnswer(60)], topInset: 40 });
    expect(t.offsetOf("a0")).toBe(40 + TOP_BLUR_RAMP + 12);
  });

  it("widens to reach a last user turn that falls above the last 80 rows", async () => {
    // 20 rows, then one prompt and 199 rows of answer.
    const t = await mount({ rows: [...thread(20, "q"), ...longAnswer(200)] }, { settled: false });
    expect(win.safeStart).toBe(20);
    expect(t.mounted()).toHaveLength(200);
    expect(t.mounted()[0]).toBe("a0");
  });
});

describe("filling the window while idle", () => {
  it("grows 120 rows per idle slice until the whole thread is mounted, then stops asking", async () => {
    await mount({ rows: thread(300) });
    expect(win.safeStart).toBe(220);
    expect(idles).toHaveLength(1);
    expect(idles[0]!.timeout).toBe(400);

    await idleSlice();
    expect(win.safeStart).toBe(220 - IDLE_CHUNK);
    await idleSlice();
    expect(win.safeStart).toBe(0);
    expect(idles).toHaveLength(0);
  });

  it("holds the reader's row under the same pixel across each prepend", async () => {
    const t = await mount({ rows: thread(300) });
    await t.scrollTo(3_040);
    rest();
    // r251 is the first row at or below the top edge: 60px below it.
    expect(t.offsetOf("r251")).toBe(60);

    await idleSlice();
    expect(win.safeStart).toBe(100);
    expect(t.scroller.scrollTop).toBe(3_040 + IDLE_CHUNK * ROW_H);
    expect(t.offsetOf("r251")).toBe(60);

    await idleSlice();
    expect(win.safeStart).toBe(0);
    expect(t.offsetOf("r251")).toBe(60);
  });

  it("is left to scrolling above 4000 rows", async () => {
    await mount({ rows: thread(MAX_IDLE_FILL) });
    expect(idles).toHaveLength(1);
    cleanup();
    idles = [];

    await mount({ rows: thread(MAX_IDLE_FILL + 2) });
    expect(idles).toHaveLength(0);
    expect(win.safeStart).toBe(MAX_IDLE_FILL + 2 - WINDOW_INITIAL);
  });

  it("does not run for a hidden tab, and resumes when it shows", async () => {
    const t = await mount({ rows: thread(300), live: false });
    expect(idles).toHaveLength(0);
    expect(win.safeStart).toBe(220);

    await t.update({ live: true });
    expect(idles).toHaveLength(1);
    await idleSlice();
    expect(win.safeStart).toBe(100);
  });

  it("backs off 180 ms while the reader is mid-fling", async () => {
    await mount({ rows: thread(300) });
    markScrollHot();
    await idleSlice();
    expect(win.safeStart).toBe(220);

    // The fling ends (its 160 ms window passes); the step retries at 180 ms.
    rest();
    await act(() => vi.advanceTimersByTimeAsync(179));
    expect(win.safeStart).toBe(220);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(win.safeStart).toBe(100);
  });
});

describe("growing on scroll", () => {
  // Long enough that the idle fill stays out of it.
  const rows = thread(MAX_IDLE_FILL + 100);
  const START = rows.length - WINDOW_INITIAL;

  it("grows 40 rows once the reader is within 2200px of the top, not a pixel sooner", async () => {
    const t = await mount({ rows });
    expect(win.safeStart).toBe(START);

    await t.scrollTo(GROW_MARGIN + 1);
    expect(win.safeStart).toBe(START);

    await t.scrollTo(GROW_MARGIN);
    expect(win.safeStart).toBe(START - WINDOW_CHUNK);
    expect(t.mounted()).toHaveLength(WINDOW_INITIAL + WINDOW_CHUNK);
  });

  it("holds position when the older rows load", async () => {
    const t = await mount({ rows });
    const anchor = `r${START + 21}`;
    await t.scrollTo(2_040);

    // The 40 rows above push everything down 4000px; the reader does not move:
    // the row that was 60px below the top edge still is.
    expect(win.safeStart).toBe(START - WINDOW_CHUNK);
    expect(t.scroller.scrollTop).toBe(2_040 + WINDOW_CHUNK * ROW_H);
    expect(t.offsetOf(anchor)).toBe(60);
  });

  it("keeps growing as the reader keeps going up, one chunk per sample", async () => {
    const t = await mount({ rows });
    await t.scrollTo(0);
    expect(win.safeStart).toBe(START - WINDOW_CHUNK);
    await t.scrollTo(1_000);
    expect(win.safeStart).toBe(START - 2 * WINDOW_CHUNK);
  });

  it("does not grow a hidden tab", async () => {
    const t = await mount({ rows, live: false });
    await t.scrollTo(0);
    expect(win.safeStart).toBe(START);
  });
});

describe("a streaming append", () => {
  const prose = (id: string, text: string) => row(id, RowKind.Prose, text);
  /** Past the four seconds in which the landed row is held (below). */
  const afterTheLandingSettles = () => {
    now += STICKY_SETTLE_MS + 1;
  };

  it("keeps the tail in view for a reader at the live edge", async () => {
    const rows = thread(100);
    const t = await mount({ rows });
    afterTheLandingSettles();
    expect(t.scroller.scrollTop).toBe(t.maxScroll());

    // A new row: the document is 100px taller, and the reader is taken with it.
    const before = t.maxScroll();
    await t.update({ rows: [...rows, prose("tail", "He")] });
    expect(t.maxScroll()).toBe(before + ROW_H);
    expect(t.scroller.scrollTop).toBe(t.maxScroll());
    expect(win.more).toBe(false);
    expect(SCROLL_BOTTOM).toBe(1 << 30);
  });

  it("re-pins when the tail's text grows, and when the working indicator comes or goes", async () => {
    const rows = [...thread(100), prose("tail", "He")];
    const t = await mount({ rows });
    afterTheLandingSettles();
    // Stand in for the tail getting taller: the reader is now short of the end.
    const drift = () => scrollTops.set(t.scroller, t.maxScroll() - 30);

    drift();
    await t.update({ rows: [...rows.slice(0, -1), prose("tail", "Hello")] });
    expect(t.scroller.scrollTop).toBe(t.maxScroll());

    drift();
    await t.update({ working: true });
    expect(t.scroller.scrollTop).toBe(t.maxScroll());
  });

  it("leaves a reader who scrolled up where they are, and counts what arrived", async () => {
    const onShowJumpChange = vi.fn();
    const rows = thread(100);
    const t = await mount({ rows, onShowJumpChange });
    await t.scrollTo(4_000);
    expect(win.more).toBe(true);
    expect(onShowJumpChange).toHaveBeenLastCalledWith(true, 0);

    await t.update({ rows: [...rows, prose("n1", "a"), prose("n2", "b"), prose("n3", "c")] });
    expect(t.scroller.scrollTop).toBe(4_000);
    expect(onShowJumpChange).toHaveBeenLastCalledWith(true, 3);

    // Back at the end (within 80px of it): caught up, the count clears.
    await t.scrollTo(t.maxScroll() - 80);
    expect(win.more).toBe(false);
    expect(onShowJumpChange).toHaveBeenLastCalledWith(false, 0);
  });

  it("does not slide the window: rows appended at the end add to it", async () => {
    const rows = thread(300);
    const t = await mount({ rows });
    await t.update({ rows: [...rows, prose("n1", "a"), prose("n2", "b")] });
    expect(win.safeStart).toBe(220);
    expect(t.mounted()).toHaveLength(WINDOW_INITIAL + 2);
  });

  it("as found: inside the four seconds after landing, the held row wins and the follow stops", async () => {
    // The reader has touched nothing. The session opened at the live edge
    // (its last prompt is on screen at the bottom), and rows stream in while
    // the landed prompt is still being held for markdown to settle.
    const rows = thread(100);
    const t = await mount({ rows });
    expect(win.more).toBe(false);

    const more = Array.from({ length: 5 }, (_, i) => prose(`n${i}`, "…"));
    await t.update({ rows: [...rows, ...more] });
    // The commit followed the tail; the resize report then put the prompt
    // (r98) back where it landed, which is no longer the end.
    expect(t.scroller.scrollTop).toBe(98 * ROW_H - 20 * ROW_H - ANCHOR_GAP);
    expect(win.more).toBe(true);

    // And the tail is not followed from here, though nothing was scrolled.
    afterTheLandingSettles();
    await t.update({ rows: [...rows, ...more, prose("n5", "…")] });
    expect(t.scroller.scrollTop).toBe(98 * ROW_H - 20 * ROW_H - ANCHOR_GAP);
  });
});

describe("switching sessions", () => {
  it("resets a fully grown window to the new session's last 80 rows and its last user turn", async () => {
    const t = await mount({ rows: thread(300) });
    await idleSlice();
    await idleSlice();
    expect(win.safeStart).toBe(0);

    const next = [...thread(140, "q"), ...longAnswer(60, "b")];
    await t.update({ rows: next, cacheKey: freshKey() }, { settled: false });
    expect(win.safeStart).toBe(next.length - WINDOW_INITIAL);
    await settle();
    expect(t.offsetOf("b0")).toBe(ANCHOR_GAP);
  });

  it("snaps to a full window when the thread shrinks under it, not to one row", async () => {
    const t = await mount({ rows: thread(300) });
    expect(win.safeStart).toBe(220);

    // "New session" in place: same key until the bind, far fewer rows.
    await t.update({ rows: thread(4, "n") });
    expect(win.safeStart).toBe(0);
    expect(t.mounted()).toEqual(["n0", "n1", "n2", "n3"]);
    // And the correction is folded into state, so the idle fill has nothing
    // stale to walk.
    expect(idles).toHaveLength(0);
  });

  it("waits for a hidden tab to catch up before settling on the new session", async () => {
    const t = await mount({ rows: [...thread(60, "q"), ...longAnswer(60)], live: false });
    // Not settled: nothing was landed on, so the scroller is where the
    // live-edge follow left it.
    expect(t.scroller.scrollTop).toBe(t.maxScroll());

    await t.update({ live: true });
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP);
  });
});

describe("closing a transcript and coming back", () => {
  // Closing the project (or the tab) unmounts the transcript; the same tab on
  // the same session mounts it again.
  it("returns a reader who had scrolled up to where they were", async () => {
    const rows = thread(300);
    const cacheKey = freshKey();
    const first = await mount({ rows, cacheKey });
    await idleSlice();
    expect(win.safeStart).toBe(100);
    await first.scrollTo(9_000);
    first.unmount();

    const again = await mount({ rows, cacheKey });
    expect(win.safeStart).toBe(100);
    expect(again.scroller.scrollTop).toBe(9_000);
  });

  it("lands a reader who left at the live edge on the last user turn again", async () => {
    const rows = [...thread(60, "q"), ...longAnswer(60)];
    const cacheKey = freshKey();
    const first = await mount({ rows, cacheKey });
    await first.scrollTo(first.maxScroll());
    first.unmount();

    const again = await mount({ rows, cacheKey });
    expect(again.offsetOf("a0")).toBe(ANCHOR_GAP);
  });
});

describe("holding the landed row while the content settles", () => {
  const rows = [...thread(60, "q"), ...longAnswer(60)];
  const drift = (el: HTMLElement, by: number) => scrollTops.set(el, el.scrollTop + by);

  it("puts the row back when markdown above it changes height", async () => {
    const t = await mount({ rows });
    drift(t.scroller, 37);
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP);
  });

  it("lets go the moment the reader takes over", async () => {
    const t = await mount({ rows });
    act(() => {
      t.scroller.dispatchEvent(new Event("wheel"));
    });
    drift(t.scroller, 37);
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP - 37);
  });

  it("lets go by itself after four seconds", async () => {
    const t = await mount({ rows });

    now += STICKY_SETTLE_MS;
    drift(t.scroller, 10);
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP);

    now += 1;
    drift(t.scroller, 10);
    await settle();
    expect(t.offsetOf("a0")).toBe(ANCHOR_GAP - 10);
  });
});
