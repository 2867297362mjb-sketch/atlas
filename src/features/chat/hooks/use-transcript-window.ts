// The transcript's window: which rows are mounted, and where the reader is.
//
// Lifted out of `transcript.tsx`; the long notes there and here are the
// design. Grows UPWARD in idle slices, re-anchors every prepend in the same
// frame, lands a reopened session on its last user turn, holds the reader's
// row while markdown settles, and follows the live edge. Every effect runs in
// the order the component declared it, which is what the scroll contract
// depends on.
//
// ── Bounded ──
//
// The window used to only grow: an idle fill mounted the whole thread, up to
// 4,000 rows, and nothing was ever unmounted again. Every mounted row is DOM,
// fibers, parsed markdown and style that each later change pays for, so a long
// session got slower to scroll the longer it was read. Now three rules keep
// what is mounted proportional to where the reader is, not to the thread:
//
//  1. The idle fill only keeps `IDLE_FILL_PX` of transcript above the reader.
//  2. While the transcript is idle, whole turns further than `UNFILL_PX` from
//     the viewport are swapped for one spacer, a GAP, whose height is the
//     turns' own measured height.
//  3. A gap that comes within `REFILL_PX` of the viewport is turned back into
//     rows, a few turns at a time, from the side nearest the reader.
//
// A gap stands only for turns that were measured while mounted, so the
// transcript still predicts no heights, and swapping either way moves nothing
// on screen. The team's reason for real rows still holds: a fling inside the
// band cannot reach a row that is not there, and the band is far deeper than
// a fling.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { isScrollHot } from "@/lib/scroll-hot";
import { RowKind, type Row } from "@tryatlas/design/session";
import { useTranscriptScroll } from "../lib/use-transcript-scroll";
import { TOP_BLUR_RAMP } from "@tryatlas/design/session";
import type { Segment } from "../lib/turn-rows";

/**
 * How many rows are added each time the window grows.
 *
 * Sized in ROWS, not turns: a collapsed tool sequence counts as one row, and an
 * opened one counts as one row carrying its calls (26px each, laid out in the
 * thread rather than in a nested scroller). Forty rows stay ahead of the reader
 * without mounting the full history at once.
 * Bursting 80 at once was visibly worse even after the blank was fixed.
 */
const WINDOW_CHUNK = 40;

/** The window starts larger than it grows: the first paint must overfill the
 *  viewport or the reader lands on a short document and can't scroll. */
const WINDOW_INITIAL = 80;

/** Rows added per idle slice while filling the window in the background.
 *  Larger than the scroll-triggered chunk — idle time is the cheap time. */
const IDLE_CHUNK = 120;

/** How much transcript (px) the idle fill keeps above the reader. Enough that
 *  a fling up rarely reaches the window's top edge before an idle slice has
 *  moved it (a prepend mid-fling is what WebKit can paint a frame early);
 *  past it, mounting more only costs every later frame. */
const IDLE_FILL_PX = 10_000;

/** Turns wholly further than this (px) from the viewport are swapped for a
 *  gap once the transcript is idle. Twice the fill, so the two never trade the
 *  same turn back and forth. */
const UNFILL_PX = 20_000;

/** A gap this close (px) to the viewport is turned back into rows. Its turns
 *  come back at the height they measured, so a refill moves nothing even
 *  mid-fling; this only has to be deeper than a frame or two of one. */
const REFILL_PX = 6000;

/** Below this many mounted rows nothing is swapped out: a window this small
 *  costs nothing worth the bookkeeping. */
const MIN_MOUNTED_ROWS = 160;

/** Turns a refill mounts at a time. */
const REFILL_TURNS = 8;

/** How long after the last scroll before far turns are swapped out. */
const UNFILL_DELAY_MS = 600;

/** Writing this to `scrollTop` clamps to the real maximum without ever reading
 *  `scrollHeight` — reading it forces a synchronous layout, and the live-edge
 *  follow runs on every streaming frame, which made that read the one forced
 *  reflow in an otherwise read-free scroll path. */
export const SCROLL_BOTTOM = 1 << 30;

/** Gap left above an anchored row, so it doesn't sit flush against the top. */
const ANCHOR_GAP = 24;
/** The ring a comment jump leaves on the row it landed on, and for how long.
 *  Same treatment as the Timeline's `landed` row. */
// `ring-inset`: a ring is a box-shadow, drawn OUTSIDE the box by default. The
// content column fills the transcript's width once the pane is narrower than
// the reading measure (the overview rail open does it), and an outer ring then
// sat past the scroller's edges — clipped on both sides, top and bottom only.
const LANDED_CLASSES = ["ring-1", "ring-inset", "ring-border-strong", "rounded-lg"];
const LANDED_MS = 2_000;

/** How long the sticky anchor keeps correcting after a load. Long enough for a
 *  screenful of markdown to finish parsing, short enough that it can never be
 *  mistaken for the transcript refusing to scroll. Any input releases it
 *  immediately regardless. */
const STICKY_SETTLE_MS = 4000;

/**
 * A run of whole turns swapped for one spacer. Named by its turns' ids, not
 * their positions, so a projection that renumbers rows cannot point it at
 * different turns.
 */
export interface Gap {
  /** Stable for the gap's life: React's key for its spacer. */
  key: string;
  /** Segment ids of its first and last turn. */
  first: string;
  last: string;
  /** Each turn's height (px) when it was swapped out, in order. */
  heights: readonly number[];
  /** Their sum: the spacer's height. */
  height: number;
}

/** A gap where the current projection puts it. */
export interface PlacedGap extends Gap {
  /** Segment indices; `to` is exclusive. */
  from: number;
  to: number;
  /** Row indices; `rowTo` is exclusive. */
  rowFrom: number;
  rowTo: number;
}

/** Per (tab, session) scroll position, so switching away and back returns the
 *  reader where they were. Stores the window too — a scrollTop means nothing
 *  without the rows and gaps it was measured in. */
interface Saved {
  startIndex: number;
  scrollTop: number;
  atEnd: boolean;
  gaps: readonly Gap[];
}
const savedScroll = new Map<string, Saved>();
/** Bound the cache: entries for closed tabs / dead sessions have no eviction
 *  hook here, so cap it FIFO — re-inserting on unmount refreshes recency
 *  (Map iteration order), keeping live tabs safe from eviction. */
const SAVED_SCROLL_CAP = 100;
function saveScroll(cacheKey: string, saved: Saved): void {
  savedScroll.delete(cacheKey);
  savedScroll.set(cacheKey, saved);
  if (savedScroll.size > SAVED_SCROLL_CAP) {
    const oldest = savedScroll.keys().next().value;
    if (oldest !== undefined) savedScroll.delete(oldest);
  }
}

let gapSeq = 0;
const nextGapKey = () => `gap-${++gapSeq}`;

const NO_GAPS: readonly Gap[] = [];
const NO_PLACED: readonly PlacedGap[] = [];

/**
 * Where each gap sits in this projection, dropping any that no longer names a
 * run of whole, settled turns inside the window. A dropped gap's turns simply
 * mount again: that is always safe, only slower.
 */
function placeGaps(
  gaps: readonly Gap[],
  segments: readonly Segment[],
  indexOf: ReadonlyMap<string, number>,
  safeStart: number,
  liveTail: boolean,
): PlacedGap[] {
  const out: PlacedGap[] = [];
  let floor = 0;
  for (const gap of gaps) {
    const from = indexOf.get(gap.first);
    const last = indexOf.get(gap.last);
    if (from === undefined || last === undefined) continue;
    const to = last + 1;
    // Out of order, overlapping, or a turn was added or removed inside it.
    if (from < floor || to - from !== gap.heights.length) continue;
    // Cut by the window's top edge, or above it.
    if (segments[from].offset < safeStart) continue;
    // The live turn is always mounted: it is still changing height.
    if (liveTail && to === segments.length) continue;
    const lastSegment = segments[last];
    out.push({
      ...gap,
      from,
      to,
      rowFrom: segments[from].offset,
      rowTo: lastSegment.offset + lastSegment.rows.length,
    });
    floor = to;
  }
  return out;
}

/** The same placement, so effects keyed on it run only when it moved. */
function samePlacement(a: readonly PlacedGap[], b: readonly PlacedGap[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.key !== y.key || x.from !== y.from || x.to !== y.to || x.height !== y.height) {
      return false;
    }
    if (x.rowFrom !== y.rowFrom || x.rowTo !== y.rowTo) return false;
  }
  return true;
}

function gapOf(
  key: string,
  segments: readonly Segment[],
  heights: readonly number[],
  from: number,
): Gap {
  return {
    key,
    first: segments[from].id,
    last: segments[from + heights.length - 1].id,
    heights,
    height: heights.reduce((sum, h) => sum + h, 0),
  };
}

/**
 * `gaps` with the turns `[a, b)` of the gap keyed `key` (positions within the
 * gap) taken out of it and mounted. What is left on either side stays a gap.
 */
function openGap(
  gaps: readonly Gap[],
  key: string,
  a: number,
  b: number,
  segments: readonly Segment[],
  indexOf: ReadonlyMap<string, number>,
): readonly Gap[] {
  const at = gaps.findIndex((gap) => gap.key === key);
  if (at < 0) return gaps;
  const gap = gaps[at];
  const from = indexOf.get(gap.first);
  if (from === undefined || from + gap.heights.length > segments.length) {
    // The projection moved under it: give up the gap whole.
    return gaps.filter((g) => g.key !== key);
  }
  const before = gap.heights.slice(0, Math.max(0, a));
  const after = gap.heights.slice(Math.min(gap.heights.length, b));
  const replacement: Gap[] = [];
  if (before.length > 0) replacement.push(gapOf(gap.key, segments, before, from));
  if (after.length > 0) {
    replacement.push(
      gapOf(
        before.length > 0 ? nextGapKey() : gap.key,
        segments,
        after,
        from + gap.heights.length - after.length,
      ),
    );
  }
  return [...gaps.slice(0, at), ...replacement, ...gaps.slice(at + 1)];
}

/** Where the turn holding `offset` px into a gap sits within it. */
function turnAt(gap: PlacedGap, offset: number): number {
  let k = 0;
  let top = 0;
  while (k < gap.heights.length - 1 && top + gap.heights[k] <= offset) {
    top += gap.heights[k];
    k++;
  }
  return k;
}

function runWhenIdle(cb: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(cb, { timeout: 1000 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(cb, 0);
  return () => window.clearTimeout(handle);
}

export interface TranscriptWindowInput {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  rows: Row[];
  /** The projection's turns, which gaps are made of. Absent, nothing is ever
   *  swapped out and the window only grows, as it used to. */
  segments?: readonly Segment[];
  /** A turn is running: the last one is still changing and never swapped. */
  turnInProgress?: boolean;
  /** Showing and caught up (`useThawed`): the only state the window moves in. */
  live: boolean;
  /** `${tabId}:${acpSessionId}` — the saved-scroll and session-switch key. */
  cacheKey: string;
  topInset: number;
  /** The working indicator is showing (it changes height without changing
   *  the row count). */
  working: boolean;
  onShowJumpChange?: (visible: boolean, newCount?: number) => void;
  /** The fling hover shield (see `use-transcript-scroll.ts`). */
  shieldRef?: RefObject<HTMLElement | null>;
}

export interface TranscriptWindow {
  setStartIndex: Dispatch<SetStateAction<number>>;
  /** Bring row `index` into the window, mounting it and the turns around it,
   *  for a jump to land on. */
  reveal: (index: number) => void;
  /** `startIndex`, corrected for a projection that shrank. Render from this. */
  safeStart: number;
  /** Gaps by the index of the segment each starts at: render one spacer of
   *  `height` there and skip to `to`. */
  gapAt: ReadonlyMap<number, PlacedGap>;
  /** Changes whenever the set of mounted rows does. */
  windowKey: string;
  /** The ids of the rows a gap stands for. */
  rowsInGap: (key: string) => string[];
  /** Content below the viewport (the jump pill and the bottom fade). */
  more: boolean;
  onScroll: () => void;
  /** A row id to bring to the top of the viewport once it has rendered. */
  pendingAnchorRef: RefObject<string | null>;
  /** Row ids a comment jump wants lit, first one in the DOM wins. */
  pendingHighlightRef: RefObject<string[] | null>;
  lastSeenLen: RefObject<number>;
  setNewCount: Dispatch<SetStateAction<number>>;
}

export function useTranscriptWindow({
  scrollRef,
  contentRef,
  rows,
  segments,
  turnInProgress = false,
  live,
  cacheKey,
  topInset,
  working,
  onShowJumpChange,
  shieldRef,
}: TranscriptWindowInput): TranscriptWindow {
  // ── The window ───────────────────────────────────────────────────────
  // Anchored by START INDEX, not by a count back from the end. A count would
  // slide the window forward as the agent streams, dropping rows off the top
  // and shifting the content under a reader who is scrolled up in history.
  const [startIndex, setStartIndex] = useState(() => Math.max(0, rows.length - WINDOW_INITIAL));
  const [gaps, setGaps] = useState<readonly Gap[]>(NO_GAPS);

  // A projection that SHRINKS — "New chat" resetting the session in place, a
  // project switch dropping history — leaves `startIndex`
  // pointing into a thread that no longer exists. Every other writer only ever
  // moves the start DOWN (growth, jump-to-message) or sets it to this floor, so
  // a start above the floor is unreachable except by a shrink: that is the
  // signal, and it is exact.
  //
  // Snapping back to a full window is the whole fix. Clamping to `rows.length
  // - 1` (what this did before) turned the empty slice into a transcript
  // showing exactly ONE row — nothing above it, nothing below the fold, so the
  // jump-to-bottom pill stayed hidden too. That reads as "the thread stopped
  // updating mid-turn", and it clears the moment anything remounts the
  // component (switching project and back), which is what made it look like a
  // stuck agent rather than a windowing bug.
  const windowFloor = Math.max(0, rows.length - WINDOW_INITIAL);
  const stale = startIndex > windowFloor;
  const safeStart = stale ? windowFloor : startIndex;
  const canGrow = safeStart > 0;

  // Fold the correction back into state. Rendering from `safeStart` alone
  // would leave `startIndex` stale, and the idle fill keys off `startIndex` —
  // it would spend its slices walking a value that no longer refers to
  // anything, never reaching 0, so the window would stop filling. The gaps go
  // with it: they described the thread that shrank.
  useEffect(() => {
    if (!stale) return;
    setStartIndex(safeStart);
    setGaps(NO_GAPS);
  }, [stale, safeStart]);

  // ── Gaps, placed in this projection ──────────────────────────────────
  const segmentIndex = useMemo(() => {
    const index = new Map<string, number>();
    segments?.forEach((segment, i) => index.set(segment.id, i));
    return index;
  }, [segments]);
  const placedRef = useRef<readonly PlacedGap[]>(NO_PLACED);
  const placed = useMemo(() => {
    const next =
      segments && gaps.length > 0
        ? placeGaps(gaps, segments, segmentIndex, safeStart, turnInProgress)
        : NO_PLACED;
    // The same placement keeps its identity: a streaming frame re-projects
    // the rows but moves no gap, and the effects keyed on this must not run
    // for it.
    return samePlacement(next, placedRef.current) ? placedRef.current : next;
  }, [gaps, segments, segmentIndex, safeStart, turnInProgress]);
  placedRef.current = placed;
  const gapAt = useMemo(() => {
    const at = new Map<number, PlacedGap>();
    for (const gap of placed) at.set(gap.from, gap);
    return at;
  }, [placed]);
  const windowKey = useMemo(
    () => `${safeStart}|${placed.map((gap) => `${gap.key}:${gap.from}-${gap.to}`).join(",")}`,
    [safeStart, placed],
  );

  // What the callbacks below read when they run, which is later than render.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const segmentIndexRef = useRef(segmentIndex);
  segmentIndexRef.current = segmentIndex;
  const safeStartRef = useRef(safeStart);
  safeStartRef.current = safeStart;
  const tailLiveRef = useRef(turnInProgress);
  tailLiveRef.current = turnInProgress;
  const liveRef = useRef(live);
  liveRef.current = live;

  const rowsInGap = useCallback((key: string) => {
    const gap = placedRef.current.find((g) => g.key === key);
    if (!gap) return [];
    return rowsRef.current.slice(gap.rowFrom, gap.rowTo).map((row) => row.id);
  }, []);

  const onGrow = useCallback(() => {
    growPendingRef.current = true;
    setStartIndex((i) => Math.max(0, i - WINDOW_CHUNK));
  }, []);

  // ── Sticky anchor: hold the reader's place while content settles ─────
  //
  // Loading a session mounts a screen of messages whose markdown is still
  // being parsed. Each one swaps from its raw-text placeholder to formatted
  // HTML at a slightly different height, and every swap above the viewport
  // pushes everything below it — the thread visibly creeps while it settles.
  // Priority parsing decides WHICH message formats first; this decides that it
  // does not move the reader when it does.
  //
  // The anchor is a ROW, not a scroll offset: offsets are exactly what the
  // reflow invalidates. Re-holding `offsetTop` (measured from the positioned
  // ancestor, so independent of scroll) puts the row back where it was.
  const stickyRef = useRef<{ rowId: string; offset: number } | null>(null);
  const stickyUntil = useRef(0);
  /** True between asking to grow and the re-anchor landing. */
  const growPendingRef = useRef(false);

  const onContentResize = useCallback(() => {
    const sticky = stickyRef.current;
    const el = scrollRef.current;
    if (!sticky || !el) return;
    // A prepend is in flight — its own re-anchor is authoritative and runs in
    // a layout effect; two corrections in one frame fight each other.
    if (growPendingRef.current) return;
    if (performance.now() > stickyUntil.current) {
      stickyRef.current = null;
      return;
    }
    const node = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(sticky.rowId)}"]`);
    if (!node) return;
    const target = Math.max(0, node.offsetTop - sticky.offset);
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
  }, []);

  /**
   * Row the reader is looking at when a grow starts, plus how far below the
   * viewport top it sat. Restoring against THIS rather than a distance from
   * the bottom is what stops the thread creeping upward while newly-prepended
   * markdown resolves — see the note in `use-transcript-scroll.ts`.
   */
  const growAnchorRow = useRef<{ rowId: string; offset: number } | null>(null);

  const captureGrowAnchor = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const top = el.scrollTop;
    // Binary search the content's direct children for the first row whose top
    // is at or below the viewport top — the row the reader's eye is anchored
    // on. Children are in document order so `offsetTop` is monotonic. This
    // runs on every idle-fill step; the old querySelectorAll walk visited
    // every row above the viewport per step, which compounds to O(rows²/chunk)
    // while filling a long thread.
    const kids = content.children;
    let lo = 0;
    let hi = kids.length - 1;
    let found: HTMLElement | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const node = kids[mid];
      if (!(node instanceof HTMLElement)) break;
      if (node.offsetTop - top >= 0) {
        found = node;
        hi = mid - 1;
      } else {
        // Row straddling the top edge — the fallback if nothing sits below.
        if (!found) found = node;
        lo = mid + 1;
      }
    }
    // A gap's spacer, the hover shield or the footer is not a row: the anchor
    // is the first row after it, or, past the last row (a tall final message
    // straddling the top edge, the footer below it), the row before it.
    let row = found;
    while (row && row.dataset.rowId === undefined) {
      const next = row.nextElementSibling;
      row = next instanceof HTMLElement ? next : null;
    }
    if (!row) {
      row = found;
      while (row && row.dataset.rowId === undefined) {
        const prev = row.previousElementSibling;
        row = prev instanceof HTMLElement ? prev : null;
      }
    }
    found = row;
    growAnchorRow.current =
      found && found.dataset.rowId !== undefined
        ? { rowId: found.dataset.rowId, offset: found.offsetTop - top }
        : null;
  }, []);

  // ── Swapping far turns out, and back in ──────────────────────────────

  /** A refill or swap that changes rows above the reader re-anchors like a
   *  grow does; this marks one in flight for the layout effect below. */
  const holdForChange = useCallback(() => {
    captureGrowAnchor();
    growPendingRef.current = true;
  }, [captureGrowAnchor]);

  /** Swap the turns that are wholly far from the viewport for gaps. Reads
   *  layout, so it only ever runs while the transcript is idle. False when
   *  something is settling and it should be tried again later. */
  const unfill = useCallback((): boolean => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const segs = segmentsRef.current;
    if (!el || !content || !segs || !liveRef.current) return true;
    // Nothing may be held right now: a landing, a jump or a grow is settling.
    const holding = stickyRef.current !== null && performance.now() <= stickyUntil.current;
    if (growPendingRef.current || holding || pendingAnchorRef.current) return false;
    const start = safeStartRef.current;
    const current = placedRef.current;
    let mounted = rowsRef.current.length - start;
    for (const gap of current) mounted -= gap.rowTo - gap.rowFrom;
    if (mounted <= MIN_MOUNTED_ROWS) return true;
    // Text selected in here, or focus in a row: swapping it out would drop it.
    const selection = document.getSelection();
    if (
      selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      content.contains(selection.anchorNode)
    ) {
      return false;
    }
    const focusedRow =
      document.activeElement instanceof HTMLElement && content.contains(document.activeElement)
        ? (document.activeElement.closest<HTMLElement>("[data-row-id]")?.dataset.rowId ?? null)
        : null;

    const byId = new Map<string, HTMLElement>();
    for (const child of content.children) {
      if (child instanceof HTMLElement && child.dataset.rowId !== undefined) {
        byId.set(child.dataset.rowId, child);
      }
    }
    const view = el.getBoundingClientRect();
    const above = view.top - UNFILL_PX;
    const below = view.top + el.clientHeight + UNFILL_PX;

    // Each turn's height if it is (or now goes) behind a gap, else null.
    const swapped = Array.from({ length: segs.length }, (): number | null => null);
    for (const gap of current) {
      for (let s = gap.from; s < gap.to; s++) swapped[s] = gap.heights[s - gap.from];
    }
    let changed = false;
    let changedAbove = false;
    const lastTurn = segs.length - 1;
    for (let s = 0; s < segs.length; s++) {
      if (swapped[s] !== null) continue;
      const segment = segs[s];
      if (segment.offset < start) continue;
      if (s === lastTurn && tailLiveRef.current) continue;
      if (segment.rows.length === 0) {
        // Renders nothing: it joins the gap before it, if there is one.
        if (s > 0 && swapped[s - 1] !== null) swapped[s] = 0;
        continue;
      }
      const first = byId.get(segment.rows[0].id);
      const last = byId.get(segment.rows[segment.rows.length - 1].id);
      if (!first || !last) continue;
      if (focusedRow !== null && segment.rows.some((row) => row.id === focusedRow)) continue;
      const top = first.getBoundingClientRect().top;
      const bottom = last.getBoundingClientRect().bottom;
      if (bottom < above) {
        changedAbove = true;
      } else if (top <= below) {
        continue;
      }
      swapped[s] = bottom - top;
      changed = true;
    }
    if (!changed) return true;

    const next: Gap[] = [];
    let s = 0;
    while (s < segs.length) {
      if (swapped[s] === null) {
        s++;
        continue;
      }
      const from = s;
      const heights: number[] = [];
      while (s < segs.length && swapped[s] !== null) heights.push(swapped[s++] as number);
      // Keep the key of a gap this one grew out of: its spacer stays mounted.
      const kept = current.find((gap) => gap.from >= from && gap.from < s);
      next.push(gapOf(kept?.key ?? nextGapKey(), segs, heights, from));
    }
    if (changedAbove) holdForChange();
    setGaps(next);
    return true;
  }, [holdForChange]);

  /** Mount part of a gap that came near the reader: the side nearest them, or
   *  the turns at the viewport if a fling outran the band. */
  const refill = useCallback(
    (key: string, side: "above" | "below" | "inside", offset: number) => {
      const segs = segmentsRef.current;
      const gap = placedRef.current.find((g) => g.key === key);
      if (!segs || !gap) return;
      const n = gap.to - gap.from;
      let a = 0;
      let b = n;
      if (side === "above") a = Math.max(0, n - REFILL_TURNS);
      else if (side === "below") b = Math.min(n, REFILL_TURNS);
      else {
        const k = turnAt(gap, offset);
        a = Math.max(0, k - 2);
        b = Math.min(n, k + REFILL_TURNS);
      }
      // Rows mounted above the reader can differ from what they measured
      // (the column narrowed since), and that difference would move them.
      if (side !== "below") holdForChange();
      setGaps((prev) => openGap(prev, key, a, b, segs, segmentIndexRef.current));
    },
    [holdForChange],
  );

  const reveal = useCallback(
    (target: number) => {
      // Widen the window first if the target is above it.
      setStartIndex((i) => (target < i ? Math.max(0, target - 10) : i));
      const segs = segmentsRef.current;
      const gap = placedRef.current.find((g) => target >= g.rowFrom && target < g.rowTo);
      if (!segs || !gap) return;
      let k = 0;
      while (k < gap.to - gap.from - 1 && segs[gap.from + k + 1].offset <= target) k++;
      const a = Math.max(0, k - 2);
      const b = Math.min(gap.to - gap.from, k + REFILL_TURNS);
      setGaps((prev) => openGap(prev, gap.key, a, b, segs, segmentIndexRef.current));
    },
    [setStartIndex],
  );

  // Swap far turns out once the reader has stopped, never mid-gesture.
  const unfillTimer = useRef<number | null>(null);
  const cancelUnfillIdle = useRef<(() => void) | null>(null);
  // `restart` is for a scroll, which pushes the swap back until the reader
  // stops; a commit only makes sure one is coming, or a streaming turn that
  // adds a row every few hundred ms would push it back forever.
  const scheduleUnfill = useCallback(
    (restart: boolean) => {
      if (!segmentsRef.current) return;
      if (!restart && (unfillTimer.current !== null || cancelUnfillIdle.current !== null)) return;
      if (unfillTimer.current !== null) window.clearTimeout(unfillTimer.current);
      cancelUnfillIdle.current?.();
      cancelUnfillIdle.current = null;
      unfillTimer.current = window.setTimeout(() => {
        unfillTimer.current = null;
        cancelUnfillIdle.current = runWhenIdle(() => {
          cancelUnfillIdle.current = null;
          // Mid-gesture, or something is settling: try again later.
          if (isScrollHot() || !unfill()) scheduleUnfill(false);
        });
      }, UNFILL_DELAY_MS);
    },
    [unfill],
  );
  useEffect(
    () => () => {
      if (unfillTimer.current !== null) window.clearTimeout(unfillTimer.current);
      cancelUnfillIdle.current?.();
    },
    [],
  );

  const {
    more,
    onScroll: onScrollSample,
    invalidate,
    atEndRef,
    growPending,
  } = useTranscriptScroll({
    scrollRef,
    contentRef,
    shieldRef,
    canGrow,
    onGrow,
    onBeforeGrow: captureGrowAnchor,
    onContentResize,
    visible: live,
  });

  // The idle fill keeps its distance only while the reader stays put; a
  // reader who scrolled up re-arms it, and every scroll re-arms the swap.
  const [fillEpoch, setFillEpoch] = useState(0);
  const fillTimer = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    onScrollSample();
    scheduleUnfill(true);
    if (fillTimer.current !== null) window.clearTimeout(fillTimer.current);
    fillTimer.current = window.setTimeout(() => {
      fillTimer.current = null;
      const el = scrollRef.current;
      if (el && el.scrollTop < IDLE_FILL_PX) setFillEpoch((n) => n + 1);
    }, UNFILL_DELAY_MS);
  }, [onScrollSample, scheduleUnfill]);
  useEffect(
    () => () => {
      if (fillTimer.current !== null) window.clearTimeout(fillTimer.current);
    },
    [],
  );

  // ── Fill the window during IDLE, not during scroll ───────────────────
  //
  // This is the difference between this list and the Session timeline, and it
  // is why the timeline never flickers. The timeline only ever APPENDS, below
  // the fold, where nothing the reader is looking at moves. A chat window
  // grows at the top, so every growth PREPENDS — the document gets taller
  // above the viewport and the scroll position has to be rebuilt to
  // compensate. Doing that on the frame the reader is mid-flick is what
  // produced the blanks: for one frame the rows exist but the scroll position
  // still refers to the old geometry.
  //
  // So don't grow on scroll if we can avoid it. Expand the window in the gaps
  // between frames instead, until `IDLE_FILL_PX` of transcript sits above the
  // reader; by the time they scroll up, the rows are already there and no
  // prepend happens at all. `requestIdleCallback` yields to scrolling by
  // construction, so this cannot compete with the gesture. The
  // scroll-triggered growth stays as a fallback for a reader who outruns it.
  //
  // It used to fill the whole thread, up to 4,000 rows, which is what made a
  // long session's DOM, and every frame after it, proportional to its length.
  useEffect(() => {
    if (startIndex === 0) return;
    // Hidden tab: don't fill. A chat stays mounted behind whichever tab is
    // showing (kept laid out, see the chat wrapper in `center-panel.tsx`), so
    // every chunk mounted here would cost DOM and layout in a panel nobody can
    // see — and a never-visited tab that stays at its initial window is what
    // keeps that wrapper cheap. The effect re-runs when the tab shows, so the
    // fill resumes in idle slices and never lands on the switch frame.
    if (!live) return;

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let idle: number | null = null;
    let timer: number | null = null;

    const step = () => {
      idle = null;
      timer = null;
      // Mid-gesture: back off. The rIC `timeout: 400` below silently broke
      // this effect's founding promise ("requestIdleCallback yields to
      // scrolling by construction") — it FORCES the step to run during a
      // long fling, and mounting IDLE_CHUNK rows stalls the main thread
      // 100-300ms while WKWebView's compositor keeps scrolling on its own
      // thread into unpainted territory. That is the black-viewport blanking,
      // no streaming required. Resume a beat after the gesture goes quiet.
      if (isScrollHot()) {
        timer = window.setTimeout(step, 180);
        return;
      }
      // A scroll-triggered grow is already in flight — let it land first, or
      // the two overwrite each other's anchor.
      if (growPending.current) return;
      // Far enough above the reader already. A reader who scrolls up re-arms
      // this (`fillEpoch`).
      const el = scrollRef.current;
      if (el && el.scrollTop >= IDLE_FILL_PX) return;
      growPending.current = true;
      captureGrowAnchor();
      growPendingRef.current = true;
      setStartIndex((i) => Math.max(0, i - IDLE_CHUNK));
    };

    if (typeof w.requestIdleCallback === "function") {
      idle = w.requestIdleCallback(step, { timeout: 400 });
    } else {
      timer = window.setTimeout(step, 100);
    }
    return () => {
      if (idle !== null && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idle);
      }
      if (timer !== null) window.clearTimeout(timer);
    };
    // Re-runs on each `startIndex` change, which is what drives the loop
    // forward one chunk per idle slice until enough sits above the reader.
  }, [startIndex, rows.length, growPending, captureGrowAnchor, live, fillEpoch]);

  // Re-anchor after growing upward, or after rows above the reader were
  // swapped in or out: put the recorded row back under the same pixel. Layout
  // effect, so the correction lands in the same frame and is never seen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = growAnchorRow.current;
    if (!el || !anchor) {
      // Nothing was recorded to hold, so the change has simply landed. Left
      // set, the flags would refuse every later grow, swap and hold.
      growPending.current = false;
      growPendingRef.current = false;
      return;
    }
    const node = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(anchor.rowId)}"]`);
    if (node) el.scrollTop = Math.max(0, node.offsetTop - anchor.offset);
    growAnchorRow.current = null;
    growPending.current = false;
    growPendingRef.current = false;
    invalidate();
  }, [startIndex, gaps, growPending, invalidate]);

  // A gap that comes near the reader turns back into rows. Watched, not
  // computed per scroll: the observer reports from the frame's own layout, so
  // the scroll path still reads nothing but `scrollTop`. Re-observing after
  // every change is what keeps a refill going while a gap stays near: an
  // observer reports each target once when it starts watching it.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || !live || placed.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const view = el.getBoundingClientRect();
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset.gap;
          if (!key) continue;
          const box = entry.boundingClientRect;
          const side =
            box.bottom <= view.top ? "above" : box.top >= view.bottom ? "below" : "inside";
          refill(key, side, view.top - box.top);
          // One at a time: the commit it causes re-observes the rest.
          return;
        }
      },
      { root: el, rootMargin: `${REFILL_PX}px 0px` },
    );
    for (const node of content.querySelectorAll<HTMLElement>("[data-gap]")) observer.observe(node);
    return () => observer.disconnect();
  }, [placed, live, refill]);

  // Anything that grows the window is a reason to look for turns to swap out.
  useEffect(() => {
    if (live) scheduleUnfill(false);
  }, [live, startIndex, rows.length, scheduleUnfill]);

  // ── Session switch: reset the window, land on the last user turn ─────
  /** A row id to bring to the top of the viewport once it has rendered. */
  const pendingAnchorRef = useRef<string | null>(null);
  const settledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Frozen rows belong to the PREVIOUS session here. A hidden tab can change
    // `cacheKey` under us (a rebind mints a new acpSessionId, "New chat"
    // resets in place), and settling against the stale row set would both
    // anchor to a row that is about to disappear and mark this session as
    // already settled — so the real content would land unanchored. Wait for
    // the catch-up; `live` is in the deps, so this runs the moment it does.
    if (!live) return;
    if (settledFor.current === cacheKey) return;
    if (rows.length === 0) return;
    settledFor.current = cacheKey;

    const saved = savedScroll.get(cacheKey);
    if (saved && !saved.atEnd) {
      setStartIndex(saved.startIndex);
      setGaps(saved.gaps);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = saved.scrollTop;
      });
      return;
    }
    setGaps(NO_GAPS);

    // Reopening lands on the LAST USER TURN, not the absolute bottom: the
    // reader needs to see what they asked with the answer starting below it.
    // Widen the window if that turn falls outside it.
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === RowKind.User || rows[i].kind === RowKind.Injected) {
        lastUser = i;
        break;
      }
    }
    const start = Math.max(0, Math.min(lastUser, rows.length - WINDOW_INITIAL));
    setStartIndex(start);
    pendingAnchorRef.current = lastUser >= 0 ? rows[lastUser].id : null;
  }, [cacheKey, rows, live]);

  // A jump from the comments panel names the row to light up once the turn is
  // on screen — the row itself when it is in the DOM (a response, a prompt),
  // else the "Worked" header hiding it. Applied imperatively: the ring is a
  // two-second decoration, not row state, and routing it through the memoized
  // row list would re-render every mounted row for it.
  const pendingHighlightRef = useRef<string[] | null>(null);
  const landedRef = useRef<{ node: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const markLanded = useCallback((row: HTMLElement) => {
    // The ring goes on the row's content column, not the full-width wrapper
    // — the same footprint the Timeline's landed entry has.
    const node = (row.firstElementChild as HTMLElement | null) ?? row;
    const prev = landedRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      prev.node.classList.remove(...LANDED_CLASSES);
    }
    node.classList.add(...LANDED_CLASSES);
    landedRef.current = {
      node,
      timer: setTimeout(() => {
        node.classList.remove(...LANDED_CLASSES);
        landedRef.current = null;
      }, LANDED_MS),
    };
  }, []);
  useEffect(() => () => void (landedRef.current && clearTimeout(landedRef.current.timer)), []);

  useLayoutEffect(() => {
    const id = pendingAnchorRef.current;
    if (!id) return;
    const el = scrollRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el || !node) return;
    pendingAnchorRef.current = null;
    let landed: HTMLElement | null = null;
    const wanted = pendingHighlightRef.current;
    if (wanted) {
      pendingHighlightRef.current = null;
      for (const rowId of wanted) {
        landed = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`);
        if (landed) break;
      }
    }
    const anchor = landed ?? node;
    // Clear the floating header and its blur band, not just the scroller's
    // edge: a gap of `ANCHOR_GAP` alone parked the landed row under the bar,
    // blurred. With a header the gap is the content's own top padding, so a
    // jump to the first row lands exactly where it rests.
    const gap = topInset ? topInset + TOP_BLUR_RAMP + 12 : ANCHOR_GAP;
    // `offsetTop` is measured from the positioned ancestor, so it is
    // independent of the current scroll position.
    el.scrollTop = Math.max(0, anchor.offsetTop - gap);
    // Hold this row in place while the screenful of markdown around it
    // finishes parsing. Without this the reader watches the thread creep as
    // each block swaps from placeholder to formatted.
    stickyRef.current = { rowId: anchor.dataset.rowId ?? id, offset: gap };
    stickyUntil.current = performance.now() + STICKY_SETTLE_MS;
    invalidate();
    if (landed) markLanded(landed);
  });

  // Any deliberate input means the reader has taken over — stop correcting
  // their position. Same release rule the scroll contract uses everywhere.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const release = () => {
      stickyRef.current = null;
    };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("keydown", release);
    el.addEventListener("mousedown", release);
    return () => {
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("keydown", release);
      el.removeEventListener("mousedown", release);
    };
  }, []);

  // ── Follow the live edge ─────────────────────────────────────────────
  // One effect. `atEndRef` is maintained by the scroll loop, so this reads no
  // layout to decide, and appends land inside the window by construction
  // (the window is anchored at its start, so it always extends to the end).
  const [newCount, setNewCount] = useState(0);
  const lastSeenLen = useRef(rows.length);
  const tail = rows[rows.length - 1];
  const tailLen =
    tail && (tail.kind === RowKind.Prose || tail.kind === RowKind.Thinking) ? tail.text.length : 0;

  // Layout effect, not effect: running after paint let each append paint one
  // frame at the old position before the correction landed — a per-frame
  // micro-jitter at the live edge. In the same frame, the correction is
  // invisible.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atEndRef.current) {
      el.scrollTop = SCROLL_BOTTOM;
      lastSeenLen.current = rows.length;
      setNewCount((c) => (c === 0 ? c : 0));
    } else {
      setNewCount(Math.max(0, rows.length - lastSeenLen.current));
    }
    // `working` is in the deps because the indicator mounting and unmounting
    // changes the document height without changing the row count — a reader
    // sitting at the live edge would otherwise drift off it.
  }, [rows.length, tailLen, working, atEndRef]);

  // Clear the unseen count once the reader catches up.
  useEffect(() => {
    if (!more) {
      lastSeenLen.current = rows.length;
      setNewCount((c) => (c === 0 ? c : 0));
    }
  }, [more, rows.length]);

  useEffect(() => {
    onShowJumpChange?.(more, more ? newCount : 0);
  }, [more, newCount, onShowJumpChange]);

  useEffect(() => () => onShowJumpChange?.(false), [onShowJumpChange]);

  // Persist position on unmount so reopening returns the reader. A tab switch
  // no longer unmounts (the panel stays mounted and laid out behind the active
  // tab, keeping `scrollTop` in the DOM); this covers closing the tab or the
  // project and coming back.
  //
  // A LAYOUT effect's cleanup, because of when each kind runs on an unmount:
  // React detaches refs and removes the nodes first, and only then runs
  // passive cleanups. As a passive effect this found `scrollRef.current`
  // already null and saved nothing, so what a reopen read back was whatever
  // the last window change had left there. A layout cleanup runs while the
  // scroller is still attached and still in the document.
  useLayoutEffect(() => {
    return () => {
      const el = scrollRef.current;
      if (!el) return;
      saveScroll(cacheKey, {
        startIndex,
        scrollTop: el.scrollTop,
        atEnd: atEndRef.current,
        gaps,
      });
    };
  }, [cacheKey, startIndex, gaps, atEndRef]);

  return {
    setStartIndex,
    reveal,
    safeStart,
    gapAt,
    windowKey,
    rowsInGap,
    more,
    onScroll,
    pendingAnchorRef,
    pendingHighlightRef,
    lastSeenLen,
    setNewCount,
  };
}
