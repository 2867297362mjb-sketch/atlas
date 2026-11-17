/**
 * The coalescing policy for the agent session-delta stream: how the deltas of
 * one animation frame fold into the batch `applyAgentBatch` applies in one
 * immer pass.
 *
 * ACP events arrive at the rate the agent streams them. For a tool-heavy turn
 * (e.g. "read 30 files") that's ~60 `tool_call` / `tool_call_update` events
 * plus a continuous text chunk stream. Applied one by one, each is 1 immer
 * draft + 1 subscriber notification + 1 transcript re-render (and the
 * virtualizer's `measureElement` runs). On a fast turn that pegs the main
 * thread.
 *
 * All deltas, text/thinking chunks INCLUDED, buffer here in strict wire order.
 * Consecutive same-session text (or thinking) chunks coalesce into the
 * trailing entry, but a `message_appended`/tool delta between two text runs
 * breaks the run so ordering is preserved. (Previously text was bucketed
 * separately and applied BEFORE other deltas, which reordered the anchoring
 * `message_appended` after its text. That was invisible for ACP agents whose
 * IPC latency spread deltas across frames, but the in-process native agent
 * emits a whole turn in one frame and the text shattered into mis-ordered
 * fragments.)
 *
 * Everything else goes in strict wire order, `message_appended` before
 * subsequent tool calls so a new assistant message anchors them correctly.
 */
import type { StreamBatch } from "@/lib/frame-coalesced-stream";
import type { AgentDelta } from "@/types/agents";

export function createAgentDeltaBatch(): StreamBatch<AgentDelta> {
  const items: AgentDelta[] = [];
  /** dedup key → index in `items` of that tool's buffered snapshot. */
  const toolDeltaPos = new Map<string, number>();
  /** live-output coalesce key → index in `items` of that tool's chunk entry. */
  const outputChunkPos = new Map<string, number>();

  // Coalesce a streaming text/thinking chunk into the trailing entry when it's
  // the same kind + session; otherwise append in order. Keeps the per-frame
  // coalescing win without divorcing text from its wire order.
  const addChunk = (env: Extract<AgentDelta, { kind: "text_chunk" | "thinking_chunk" }>) => {
    const last = items[items.length - 1];
    if (
      last &&
      (last.kind === "text_chunk" || last.kind === "thinking_chunk") &&
      last.kind === env.kind &&
      last.session_id === env.session_id
    ) {
      items[items.length - 1] = { ...last, delta: last.delta + env.delta };
    } else {
      items.push(env);
    }
  };

  // Coalesce incremental live tool output. Priority order matters for
  // correctness, not just batching:
  // 1. A full `tool_call_upserted` snapshot for this tool is already
  //    buffered: fold the delta into ITS `result`. A separate chunk entry
  //    would double-apply: a later snapshot replaces that buffer slot with
  //    a result that already contains every earlier chunk, and the stray
  //    chunk entry would then append the same bytes again.
  // 2. This tool's previous buffered entry is a chunk: concatenate.
  // 3. Fresh chunk entry. (Chunks buffered BEFORE a tool's first snapshot
  //    of the frame stay safe: they apply first and the later snapshot
  //    replaces the result wholesale.)
  const addOutputChunk = (env: Extract<AgentDelta, { kind: "tool_call_output_chunk" }>) => {
    const key = `${env.session_id}::${env.tool_call_id}`;
    const upsertAt = toolDeltaPos.get(key);
    if (upsertAt !== undefined) {
      const entry = items[upsertAt];
      if (entry?.kind === "tool_call_upserted") {
        items[upsertAt] = {
          ...entry,
          tool_call: {
            ...entry.tool_call,
            result: (entry.tool_call.result ?? "") + env.delta,
          },
        };
        return;
      }
    }
    const chunkAt = outputChunkPos.get(key);
    const prev = chunkAt !== undefined ? items[chunkAt] : undefined;
    if (prev?.kind === "tool_call_output_chunk" && chunkAt !== undefined) {
      items[chunkAt] = { ...prev, delta: prev.delta + env.delta };
      return;
    }
    outputChunkPos.set(key, items.length);
    items.push(env);
  };

  const add = (env: AgentDelta) => {
    switch (env.kind) {
      case "text_chunk":
      case "thinking_chunk":
        addChunk(env);
        return;
      case "tool_call_output_chunk":
        addOutputChunk(env);
        return;
      case "tool_call_upserted": {
        // Coalesce same-id `tool_call_upserted` events: replace the entry at
        // the position the tool first appeared so the latest state lands and
        // ordering vs other events stays correct. A tool that flips through
        // pending → running → completed in a single frame contributes once.
        const key = `${env.session_id}::${env.tool_call.id}`;
        const existing = toolDeltaPos.get(key);
        if (existing !== undefined) {
          items[existing] = env;
          return;
        }
        toolDeltaPos.set(key, items.length);
        items.push(env);
        return;
      }
      default:
        items.push(env);
    }
  };

  return { items, add };
}
