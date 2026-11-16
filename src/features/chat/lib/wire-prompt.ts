// What the agent is sent for a message: the prose with its mentions expanded,
// the files it links, the pastes it carries. Split from the send itself
// (`session-send.ts`) so the send can be tested without `compose_prompt`.

import { toast } from "sonner";
import { withContextsInline } from "@/features/ask-agent/lib/agent-context";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useSessionProjectsStore } from "../stores/session-projects-store";
import { attachMentionedProjects, isProjectMention } from "./attach-mentioned-projects";
import { withCitesInline } from "./cited-text";
import { composePrompt, type MentionData } from "./mentions";
import { appendNextStepsDirective } from "./next-steps";
import { withReviewCommentsInline } from "./review-comments";

export interface WirePrompt {
  prompt: string;
  resourceLinks: { uri: string; name: string }[];
  pastedTexts: { id: string; text: string }[];
}

/** Compose `content` for the agent of ACP session `acpSessionId`. */
export async function composeWirePrompt(
  acpSessionId: string,
  content: string,
  mentions: MentionData[],
): Promise<WirePrompt> {
  // Expand mentions. Bodies that have no URI (notes, papers, past sessions)
  // still append under a fenced `## @ref` section; file/folder mentions come
  // back as structured `resourceLinks` and ride as ACP `ResourceLink` blocks
  // instead (P2.1) — see `mentions.ts::composePrompt`.
  let prompt: string;
  let resourceLinks: { uri: string; name: string }[] = [];
  let pastedTexts: { id: string; text: string }[] = [];
  // A project or repo the message mentions is attached to the session
  // (read-only unless already granted more), and its mention tells the
  // agent the access it holds there.
  let composeMentions = mentions;
  if (mentions.some(isProjectMention)) {
    const attached = await attachMentionedProjects(acpSessionId, mentions);
    composeMentions = attached.mentions;
    if (attached.projects) {
      useSessionProjectsStore.getState().actions.replace(acpSessionId, attached.projects);
    }
    for (const r of attached.refused) {
      toast.warning(`${r.displayName} was not attached to this session`, {
        description: r.reason,
      });
    }
  }
  try {
    const composed = await composePrompt(content, composeMentions);
    prompt = composed.prose;
    resourceLinks = composed.resourceLinks;
    pastedTexts = composed.pastedTexts;
  } catch (err) {
    console.warn("composePrompt failed, sending raw text:", err);
    // A cite's passage is only in the context block `compose_prompt`
    // writes, so without one it is written out after the prose.
    prompt = withContextsInline(
      withReviewCommentsInline(withCitesInline(content, mentions), mentions),
      mentions,
    );
    // A paste is never only in the prose (just its `@paste:` token), so it
    // must survive a failed compose too.
    pastedTexts = mentions.flatMap((m) =>
      m.kind === "pasted_text" ? [{ id: m.id, text: m.text }] : [],
    );
  }

  // Ask the agent to end its reply with a hidden `<next_steps>` block — it has
  // the live session context, so the suggestions are better than a separate
  // model's. Appended to the WIRE prompt only (not the visible message); the
  // directive + the block are stripped from the thread. Gated on the setting.
  return { prompt: withNextSteps(prompt), resourceLinks, pastedTexts };
}

function withNextSteps(text: string): string {
  return useSettingsStore.getState().settings.adaptiveSuggestions !== "off"
    ? appendNextStepsDirective(text)
    : text;
}

/** What the agent is sent for a queued prompt: what was typed, plus the hidden
 *  next-steps directive when that setting is on — what a direct send of the
 *  same text sends. `text` is already inlined (`inlineQueuedText`): queued
 *  prompts carry no structured mentions. */
export function queuedWirePrompt(text: string): string {
  return withNextSteps(text);
}
