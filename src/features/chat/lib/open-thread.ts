// Open a history row: the one path every list of past sessions uses (the
// sidebar, its search, the settle chord moving on to the next session).
//
// The session's project becomes the active one first — a session resumes in
// its own directory, and the shell (files, source control, terminal) has to
// be looking at the same project. Then the tab:
//
//   1. An open tab already holds the session → focus it. Only a tab that still
//      exists: closing a chat leaves its chat-store session behind, and
//      focusing that dead id makes `setActiveTab` bounce to the first tab.
//   2. `intoTab` is given (the settle chord moving the same tab on) and that
//      tab is not mid-turn → load into it.
//   3. The active tab is an idle chat → load into it in place.
//   4. Otherwise a fresh tab, so a running session is never overwritten.
//
// The load itself is optimistic (bind, skeleton, then one paint once the
// agent has the session — see `resume-session.ts`), and each request bumps
// the target tab's load token, so rapid clicks collapse to the last one.

import { toast } from "sonner";
import { agentTypeFromPluginId, isBusyAgentStatus, pluginIdForAgent } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "../stores/chat-store";
import { getAgentSync } from "./agents-api";
import { bumpLoadToken, isLoadStale } from "./load-tokens";
import { ResumeError, resumeThreadFast } from "./resume-session";
import { applyModeOnResume, holdUnrestoredMode } from "./resume-mode";
import { snapshotLive } from "./snapshot-message";
import { clearKeepingUnsent } from "./unsent-text";
import { AGENT_TYPE_BY_SIDEBAR, type SidebarAgent } from "./sidebar-agents";

export interface OpenableThread {
  threadId: string;
  /** The agent's session id; empty for a row that has none. */
  sessionId: string;
  title: string;
  agent: SidebarAgent;
  /** The session's own directory — where it resumes. */
  cwd: string;
  /** The project it belongs to, made active before the session opens. */
  projectPath: string;
}

function freshTabId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The tab that already shows `sessionId`, if one is open. A saved tab that
 *  has not loaded it yet counts (`ChatSession.pendingRestore`): focusing that
 *  tab is what loads it, and loading it into a second tab would show one
 *  session twice. */
export function tabShowingSession(sessionId: string): string | null {
  if (!sessionId) return null;
  const openTabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
  for (const [tabId, session] of Object.entries(useChatStore.getState().sessions)) {
    if (!openTabIds.has(tabId)) continue;
    if (session.acpSessionId === sessionId || session.pendingRestore === sessionId) return tabId;
  }
  return null;
}

/** Make the project at `path` the active one (registering it in the active
 *  organisation when it is not open there yet). */
async function activateProject(path: string): Promise<void> {
  if (!path) return;
  const projects = useProjectStore.getState();
  const current = useAppStore.getState().currentProject?.path;
  if (current === path) return;
  const orgId = useOrgStore.getState().activeOrganisationId;
  const project = projects.projects.find((p) => p.path === path && p.orgId === orgId);
  if (project) {
    if (project.id !== projects.activeProjectId) await projects.actions.switchTo(project.id);
  } else {
    await projects.actions.addProject(path);
  }
}

export async function openThread(
  thread: OpenableThread,
  opts: { intoTab?: string } = {},
): Promise<void> {
  const open = tabShowingSession(thread.sessionId);
  if (open) {
    if (useAppStore.getState().currentProject?.path !== thread.projectPath) {
      await activateProject(thread.projectPath);
    }
    useLayoutStore.getState().actions.setActiveTab(open);
    return;
  }

  await activateProject(thread.projectPath);

  const layout = useLayoutStore.getState();
  const chat = useChatStore.getState();
  const { addTab, setActiveTab } = layout.actions;
  const { createSession } = chat.actions;

  const idleChat = (tabId: string | null | undefined): tabId is string =>
    !!tabId &&
    layout.tabs.some((t) => t.id === tabId && t.type === "chat") &&
    !isBusyAgentStatus(chat.sessions[tabId]?.status);
  const targetTabId = idleChat(opts.intoTab)
    ? opts.intoTab
    : idleChat(layout.activeTabId)
      ? layout.activeTabId
      : freshTabId();

  if (!layout.tabs.some((t) => t.id === targetTabId)) {
    addTab({
      id: targetTabId,
      type: "chat",
      title: thread.title.slice(0, 40) || "Session",
      closable: true,
      dirty: false,
      data: {},
    });
    createSession(targetTabId, agentTypeOf(thread));
  }
  setActiveTab(targetTabId);

  await loadThreadIntoTab(targetTabId, thread);
}

/** The agent that ran a session, from its row — not the tab's current pick.
 *  Opening a Codex session into a Claude tab resumed it through the wrong
 *  process. */
function agentTypeOf(thread: OpenableThread) {
  return AGENT_TYPE_BY_SIDEBAR[thread.agent] ?? thread.agent;
}

/**
 * Put `thread` into chat tab `targetTabId`: the optimistic bind, the skeleton, the
 * agent reopening the session, one paint, and then everything the snapshot
 * carries. Answers whether the session is now in the tab.
 *
 * `keep`: the tab holds an empty session of its own and is getting its saved
 * conversation back (`restore-tab-session.ts`), so there is no other
 * conversation to clear out of it, and what is queued in it is meant for the
 * session being loaded.
 */
export async function loadThreadIntoTab(
  targetTabId: string,
  thread: OpenableThread,
  opts: { keep?: boolean } = {},
): Promise<boolean> {
  const {
    replaceMessages,
    setAcpBinding,
    setAcpModels,
    setAcpConfigOptions,
    setAcpAvailableCommands,
    setSessionAgentType,
    clearSession,
    setSessionTitle,
    setTranscriptLoading,
    setResumePending,
    hydrateSessionSnapshot,
  } = useChatStore.getState().actions;
  const agentType = agentTypeOf(thread);
  const pluginId = pluginIdForAgent(agentType);
  const cwd = thread.cwd || thread.projectPath;

  if (!opts.keep) clearSession(targetTabId);
  setSessionAgentType(targetTabId, agentType);
  setSessionTitle(targetTabId, thread.title.slice(0, 40));
  const cachedAgent = getAgentSync(pluginId);
  if (cachedAgent && thread.sessionId) {
    // Optimistic: the backend has not loaded it yet, so a send queues rather
    // than firing at a session the manager lacks.
    setAcpBinding(targetTabId, cachedAgent.agent_id, thread.sessionId, cwd);
  }
  setResumePending(targetTabId, true);
  setTranscriptLoading(targetTabId, true);

  const token = bumpLoadToken(targetTabId);
  const isStale = () => isLoadStale(targetTabId, token);

  await Promise.resolve();
  if (isStale()) return false;

  let resumed;
  try {
    resumed = await resumeThreadFast({
      threadId: thread.threadId,
      cwd,
      sessionId: thread.sessionId || null,
      cb: {
        paint: (msgs, asOfSeq) => replaceMessages(targetTabId, msgs, asOfSeq),
        onPainted: () => setTranscriptLoading(targetTabId, false),
        onOpened: (key) => setAcpBinding(targetTabId, key.agent_id, key.session_id, cwd),
        isStale,
      },
    });
  } catch (err) {
    if (isStale()) return false;
    setResumePending(targetTabId, false);
    setTranscriptLoading(targetTabId, false);
    const stage = err instanceof ResumeError ? err.stage : "resume";
    const msg = err instanceof Error ? err.message : String(err);
    if (stage === "snapshot") {
      // The session IS open — only reading it back failed. Keep the bind, and
      // since the mode was never applied, hold sends until a pick.
      holdUnrestoredMode(targetTabId);
      toast.error(`Couldn't load session: ${msg}`);
      return true;
    } else {
      // Roll the optimistic binding back: a tab bound to a session the backend
      // never opened is stranded (the chat panel's bind effect skips a tab that
      // already has a binding). The history row is untouched. What the user
      // sent while it loaded goes back to the composer, not with the reset.
      console.warn("resume failed:", err);
      const kept = clearKeepingUnsent(targetTabId);
      toast.error(
        `Couldn't resume this session: ${msg.slice(0, 120)}` +
          (kept ? " What you sent is back in the composer." : ""),
      );
    }
    return false;
  }
  if (isStale()) return false;

  const { key, snapshot } = resumed;
  setAcpBinding(targetTabId, key.agent_id, key.session_id, cwd);
  // Before the send gate opens: `setResumePending(false)` releases a queued
  // prompt, and a mode applied after it can lose the race to the first turn.
  await applyModeOnResume(targetTabId, key, snapshot);
  if (isStale()) return false;
  setResumePending(targetTabId, false);
  if (resumed.resumedWithoutHistory) {
    toast.info("This agent can't replay past messages — it won't remember what's above.");
  }
  // With its subagents: the bind cleared them, and a finished child is never
  // re-announced by a live delta.
  hydrateSessionSnapshot(
    targetTabId,
    snapshot.status,
    snapshot.plan,
    snapshot.subagents,
    snapshotLive(snapshot),
  );
  if (snapshot.available_models.length > 0) {
    setAcpModels(targetTabId, snapshot.current_model, snapshot.available_models);
  }
  setAcpAvailableCommands(targetTabId, snapshot.available_commands ?? []);
  // Tagged with the snapshot's own agent so a stale binding cannot seed
  // another agent's pill or cache.
  setAcpConfigOptions(
    targetTabId,
    snapshot.config_options ?? [],
    agentTypeFromPluginId(snapshot.plugin_id),
  );
  setTranscriptLoading(targetTabId, false);
  return true;
}
