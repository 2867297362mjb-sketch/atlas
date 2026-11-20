import type { SessionKey } from "@/types/agents";
import { pluginIdForAgent } from "@/types/agent";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "../stores/chat-store";
import { agents, ensureAgent } from "./agents-api";
import { resumeThread, threadHistory } from "./history-api";
import { projectPathForTab } from "./tab-project";
import { applyModeOnResume, holdUnrestoredMode } from "./resume-mode";
import { snapshotMessageToWire } from "./snapshot-message";

// Rebinds in flight, per tab. Restart and Send both call the rebind, and a
// queued message drains the moment the tab is bound; a second caller that
// arrives while one is running joins it instead of respawning again.
const rebindsInFlight = new Map<string, Promise<boolean>>();

/** Rebind a session whose agent process died: respawn the plugin (its spawn
 *  cache was reset on disconnect) and reopen the same session id with
 *  whichever of `session/load` / `session/resume` the agent supports
 *  (`reopen`) — starting over, and saying so in the chat, only when it can do
 *  neither. Never runs unprompted: only
 *  the next Send or the explicit Restart affordance calls this (no silent
 *  auto-restart loops). */
export function rebindDisconnectedSession(tabId: string): Promise<boolean> {
  const running = rebindsInFlight.get(tabId);
  if (running) return running;
  const rebind = respawnAndRebind(tabId).finally(() => rebindsInFlight.delete(tabId));
  rebindsInFlight.set(tabId, rebind);
  return rebind;
}

async function respawnAndRebind(tabId: string): Promise<boolean> {
  const cs = useChatStore.getState();
  const sess = cs.sessions[tabId];
  if (!sess) return false;
  const pluginId = pluginIdForAgent(sess.agentType);
  try {
    const agent = await ensureAgent(pluginId);
    // The session's own binding first, then the TAB's project. `currentProject`
    // is the active project's — wrong for a background project's chat panel,
    // which stays mounted and can rebind while another project is in front.
    const cwd =
      sess.workingDirectory ||
      projectPathForTab(tabId) ||
      useAppStore.getState().currentProject?.path ||
      "/";
    let key: SessionKey;
    let loaded = false;
    let startedOver = false;
    const reopened = sess.acpSessionId
      ? await reopen(agent.agent_id, sess.acpSessionId, cwd)
      : null;
    if (reopened) {
      key = reopened.key;
      loaded = reopened.replayed;
    } else {
      key = (await agents.newSession(agent.agent_id, cwd)).key;
      // Said in the chat, not only logged: the conversation above stays on
      // screen, and the agent now remembers none of it.
      startedOver = !!sess.acpSessionId;
    }
    // `session/load` replays the whole conversation into the thread. The
    // stream does not announce that replay (`attach_settled` in Rust): it is
    // history, and this repaint from the reloaded thread is how the tab takes
    // it, as opening a history row does (`resume-session.ts`). Each replayed
    // message used to arrive as an append as well, onto a tab still showing
    // it, so every earlier message came back a second time.
    // An agent that resumed without replaying hands back an empty thread;
    // then what is on screen is the record, and stays.
    if (loaded) {
      try {
        const snapshot = await agents.snapshot(key);
        if (snapshot.messages.length > 0) {
          useChatStore
            .getState()
            .actions.replaceMessages(tabId, snapshot.messages.map(snapshotMessageToWire));
        }
      } catch (err) {
        console.warn("repaint after agent restart failed:", err);
      }
    }
    // The respawned agent starts on its OWN default, and a bind does not
    // reset `acpModeExplicit`/`acpCurrentMode` — so without this the pill kept
    // showing the user's pick while the agent enforced its default. That is the
    // half of issue 289's second bug `resume-mode.ts` exists to prevent, on
    // the one resume path that was left out of it. Awaited BEFORE
    // `setAcpBinding`, as the session/new path does: binding is what flushes a
    // queued send (a tab that never bound goes from no `acpSessionId` to one),
    // so the first turn after a restart cannot run under a mode the user never
    // picked. Snapshot failure is not a rebind failure: the session exists, so
    // warn and leave the agent on its own default.
    try {
      await applyModeOnResume(tabId, key, await agents.snapshotMeta(key));
    } catch (err) {
      console.warn("mode restore after agent restart failed:", err);
      holdUnrestoredMode(tabId);
    }
    // Bind and clear the flag in the same tick, so a send the bind releases
    // never sees the tab still disconnected.
    const actions = useChatStore.getState().actions;
    actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
    actions.setDisconnected(tabId, false);
    if (startedOver) {
      actions.addMessage(
        tabId,
        "assistant",
        "(the agent could not reopen this conversation after it restarted — it starts over from here and does not remember the messages above)",
      );
    }
    return true;
  } catch (err) {
    console.warn("agent restart failed:", err);
    return false;
  }
}

/**
 * Open `sessionId` on the restarted agent, keeping its context: through its
 * thread when it has one, which the backend opens with `session/load` or
 * `session/resume`, whichever the agent advertised (as opening a history row
 * does), else with `session/load`. Null when neither can: the caller starts
 * over, and says so.
 *
 * `session/load` alone, with a quiet new session on any failure, left a
 * resume-only agent (or a load that timed out) with the old conversation on
 * screen and none of it in the agent's context (audit #4).
 */
async function reopen(
  agentId: string,
  sessionId: string,
  cwd: string,
): Promise<{ key: SessionKey; replayed: boolean } | null> {
  try {
    const row = (await threadHistory()).find((r) => r.sessionId === sessionId);
    if (row) {
      const resumed = await resumeThread(row.threadId);
      return { key: resumed.key, replayed: !resumed.resumedWithoutHistory };
    }
  } catch (err) {
    console.warn("reopening the session through its thread failed:", err);
  }
  try {
    return { key: await agents.loadSession(agentId, sessionId, cwd), replayed: true };
  } catch (err) {
    console.warn("reopening the session failed; starting over:", err);
    return null;
  }
}
