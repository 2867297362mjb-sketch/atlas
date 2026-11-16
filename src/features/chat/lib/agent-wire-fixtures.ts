/**
 * Wire-typed session deltas for tests, built the way
 * `chat-store.deltas.test.ts` builds them: every body is checked against the
 * generated `AgentDelta` union, so a fixture cannot drift from the wire.
 */
import type { AgentDelta, SessionMessage, ToolCall } from "@/types/agents";

export const AGENT = "agent-1";
export const SESSION = "acp-session-1";
export const OTHER_SESSION = "acp-session-2";

type Kind = AgentDelta["kind"];
type Body<K extends Kind> = Omit<
  Extract<AgentDelta, { kind: K }>,
  "kind" | "agent_id" | "session_id" | "seq"
>;

/** One wire delta. `seq` 0 is what an envelope built outside the projector
 *  carries. */
export function delta<K extends Kind>(
  kind: K,
  body: Body<K>,
  sessionId: string = SESSION,
): Extract<AgentDelta, { kind: K }> {
  // One generic spread TypeScript cannot narrow back to the union member.
  return { kind, agent_id: AGENT, session_id: sessionId, seq: 0, ...body } as unknown as Extract<
    AgentDelta,
    { kind: K }
  >;
}

export function wireMessage(id: string, over: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id,
    role: "assistant",
    mode: "text",
    content: "",
    tool_calls: [],
    timestamp: "2026-09-18T10:00:00Z",
    ...over,
  };
}

export function wireTool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    tool_name: "Bash",
    title: null,
    kind: "execute",
    status: "running",
    arguments: { command: "ls" },
    result: null,
    locations: [],
    ...over,
  };
}

export const text = (d: string, sessionId?: string) =>
  delta("text_chunk", { message_id: "m1", delta: d }, sessionId);
export const thinking = (d: string, sessionId?: string) =>
  delta("thinking_chunk", { message_id: "m1", delta: d }, sessionId);
export const toolUpsert = (id: string, over: Partial<ToolCall> = {}, sessionId?: string) =>
  delta("tool_call_upserted", { message_id: "m1", tool_call: wireTool(id, over) }, sessionId);
export const toolOutput = (id: string, d: string, sessionId?: string) =>
  delta("tool_call_output_chunk", { message_id: "m1", tool_call_id: id, delta: d }, sessionId);
export const messageAppended = (id: string) =>
  delta("message_appended", { message: wireMessage(id) });
