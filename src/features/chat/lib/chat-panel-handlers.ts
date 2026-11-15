import type { Dispatch, RefObject, SetStateAction } from "react";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { logEvent } from "@/features/log/lib/log";
import type { ImageAttachment } from "@/types/agents";
import { pluginIdForAgent } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import type { BindControl } from "../hooks/use-agent-bind";
import { agents, resetAgent } from "./agents-api";
import { cycleChatAgent } from "./switch-agent";
import { errInfo } from "./agent-signin";
import type { MentionData } from "./mentions";
import { sessionSend } from "./session-send";

/** The panel's send handler. `opts.recorded`: the user bubble, title and
 *  running status were already applied when this message was held; only
 *  dispatch. `opts.clientMessageId`: that bubble's id, when the caller knows it. */
export type ChatSendHandler = (
  content: string,
  mentions: MentionData[],
  attachments?: ImageAttachment[],
  opts?: { recorded?: boolean; clientMessageId?: string },
) => Promise<void> | void;

interface ChatPanelHandlerContext {
  tabId: string;
  bindControlRef: RefObject<BindControl | null>;
  setBindEpoch: Dispatch<SetStateAction<number>>;
}

/**
 * The chat panel's send / stop / restart handlers. Built afresh on every
 * render of a panel with a session, exactly as the inline closures they were:
 * the panel hands them to its stable wrappers through refs.
 */
export function createChatPanelHandlers({
  tabId,
  bindControlRef,
  setBindEpoch,
}: ChatPanelHandlerContext) {
  /** "Restart agent" on the stall notice: kill the plugin's (wedged) connect,
   *  forget the cached agent, re-arm the per-tab dedupes and bind again. The
   *  held first message stays held and dispatches when the new bind lands. */
  const handleRestartAgent = async () => {
    const pid = pluginIdForAgent(useChatStore.getState().sessions[tabId]?.agentType);
    setBindEpoch((n) => n + 1);
    logEvent({
      source: "atlas",
      kind: "agent-bind",
      summary: `${agentMeta(useChatStore.getState().sessions[tabId]?.agentType).label}: restart requested while starting`,
      payload: { tabId },
    });
    try {
      await agents.killPlugin(pid);
    } catch (e) {
      console.warn("killPlugin on restart failed:", e);
    }
    resetAgent(pid);
    bindControlRef.current?.retry();
  };
  /** "Switch agent" on the stall notice — the same path as ⌥/. With a first
   *  message held and no session yet, the switch happens in this tab and the
   *  message carries over (see `switchAgentForTab`). */
  const handleSwitchAgent = () => cycleChatAgent(tabId);
  /** "Copy diagnostics" on the stall notice: install state, npm log and
   *  Atlas log tails for this agent, as one text blob for a support report. */
  const handleCopyDiagnostics = async () => {
    const pid = pluginIdForAgent(useChatStore.getState().sessions[tabId]?.agentType);
    let text: string;
    try {
      text = await agents.startDiagnostics(pid);
    } catch (e) {
      toast.error(`Could not gather diagnostics: ${errInfo(e).message}`);
      return;
    }
    if (await copyText(text)) toast.success("Diagnostics copied");
    else toast.error("Could not copy diagnostics to the clipboard");
  };

  // What a stop and a send DO is `session-send.ts`'s; these turn the panel's
  // event into the intent, with the panel's handle on its bind.
  const handleStop = () => sessionSend.stop(tabId, () => bindControlRef.current?.abandon());

  const handleSend: ChatSendHandler = (content, mentions, attachments, opts) =>
    sessionSend.send(
      tabId,
      { content, mentions, attachments },
      { ...opts, kickBind: () => bindControlRef.current?.kick() },
    );

  return {
    handleRestartAgent,
    handleSwitchAgent,
    handleCopyDiagnostics,
    handleStop,
    handleSend,
  };
}
