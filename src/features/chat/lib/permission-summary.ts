// What the permission card says about a tool call: its headline, and the text
// in its preview box.
//
// ACP puts no limit on a tool call's `title`, and agents use it for the whole
// command: the native agent sends the command as the title and no input at
// all, and the Claude adapter sends the command in backticks. The card's
// headline is one sentence with no scroll, so a sixty-line heredoc there grew
// the card past the window and pushed its options off screen. A title that
// does not fit a headline is named by its kind instead, and its text goes to
// the preview box, which keeps line breaks and scrolls inside the card.

import type { ToolCallRef } from "@/types/acp";

/** The longest title the headline takes, in characters, on one line. */
export const HEADLINE_MAX = 80;

/** The cap on an input drawn as JSON. A command is never cut: the user is
 *  approving all of it. */
const JSON_MAX = 4000;

export interface PermissionSummary {
  /** What follows "The agent wants to run". */
  title: string;
  /** The title is Atlas's name for the call's kind, not the agent's text. */
  generic: boolean;
  /** The preview box's text, or null for no box. */
  preview: string | null;
}

export function permissionSummaryOf(toolCall: ToolCallRef): PermissionSummary {
  const title = toolCall.title ?? toolCall.kind ?? "Tool call";
  const input = toolCall.rawInput ?? (toolCall as Record<string, unknown>).input;
  if (title.length <= HEADLINE_MAX && !/[\r\n]/.test(title)) {
    return { title, generic: false, preview: input !== undefined ? jsonOf(input) : null };
  }
  const command = commandOf(input);
  const rest = command ?? (input !== undefined ? jsonOf(input) : null);
  return {
    title: nounFor(toolCall.kind),
    generic: true,
    preview:
      rest === null
        ? title
        : command !== null && sameCommand(title, command)
          ? command
          : `${title}\n\n${rest}`,
  };
}

/** The kind as a noun phrase, to end "The agent wants to run …?". */
function nounFor(kind: string | undefined): string {
  return kind === "execute" ? "a command" : kind === "edit" ? "a file edit" : "a tool call";
}

/** The input's command when it has one as plain text. */
function commandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command : null;
}

/** Whether a title is its command again: as it is, or wrapped in backticks
 *  with the command's own backticks escaped (the Claude adapter's form). */
function sameCommand(title: string, command: string): boolean {
  const bare = title.trim();
  const unwrapped =
    bare.length > 1 && bare.startsWith("`") && bare.endsWith("`")
      ? bare.slice(1, -1).replaceAll("\\`", "`")
      : bare;
  return bare === command.trim() || unwrapped === command.trim();
}

function jsonOf(value: unknown): string {
  try {
    const s = JSON.stringify(value, null, 2);
    return s.length > JSON_MAX ? s.slice(0, JSON_MAX) + "\n…(truncated)" : s;
  } catch {
    return String(value);
  }
}
