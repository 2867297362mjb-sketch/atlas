import type { ToolCallDisplay } from "@/types/agent";

/**
 * Recognising bash/shell tool calls is subtle because the two ingest paths
 * label them differently:
 *   - Live ACP stream (`manager.rs`): `toolName` is the ACP *title*, which for
 *     Bash is the command itself (e.g. `bun install`), and `kind` is "execute".
 *   - Reloaded transcript (`transcript.rs`): `toolName` is the Claude Code tool
 *     name "Bash"; `kind` is mapped to "execute" on replay.
 * So the reliable signal is `kind === "execute"`, with a tool-name fallback for
 * any agent that doesn't set a kind.
 */
const BASH_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "execute",
  "run_command",
  "run-command",
]);

export function isBashToolCall(tc: Pick<ToolCallDisplay, "kind" | "toolName">): boolean {
  if (tc.kind === "execute") return true;
  return BASH_TOOL_NAMES.has(tc.toolName.toLowerCase());
}

/** The shell command from a bash tool call's arguments, or "" if absent.
 *
 *  The arguments are the agent's raw input, free-form JSON: a command can come
 *  as an argv array (`["bash", "-lc", "ls"]`), shown joined. Anything else is
 *  no command at all. Cast unchecked, a non-string here threw inside the row
 *  projection and took the whole window down with it (audit #94). */
export function bashCommandOf(args: Record<string, unknown> | null | undefined): string {
  return commandText(args?.command) ?? commandText(args?.cmd) ?? "";
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
    return value.join(" ");
  }
  return undefined;
}
