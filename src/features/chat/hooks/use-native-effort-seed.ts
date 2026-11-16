import { useEffect } from "react";
import { sessionConfiguration, useChatStore } from "../stores/chat-store";
import { KNOBS } from "../lib/session-configuration";
import { loadNativeEffort } from "../lib/native-model-pref";

export function useNativeEffortSeed(tabId: string, agentType: string): void {
  // Seed the reasoning-effort from the saved preference once per native session,
  // then re-push it whenever the session is bound (mirrors the model re-push).
  const nativeEffort = useChatStore((s) => s.sessions[tabId]?.nativeEffort);
  const nativeBound = useChatStore((s) => {
    const sess = s.sessions[tabId];
    return sess?.agentType === "atlas-agent" && !!sess.acpAgentId && !!sess.acpSessionId
      ? `${sess.acpAgentId}::${sess.acpSessionId}`
      : null;
  });
  useEffect(() => {
    if (agentType !== "atlas-agent") return;
    // Undefined = never set for this session → seed from the global pref.
    const eff = nativeEffort ?? loadNativeEffort();
    // A re-apply, not a pick: the user chose nothing just now, so there is
    // nothing to remember and a refusal is not theirs to hear about.
    if (nativeBound || nativeEffort === undefined) {
      void sessionConfiguration.reapply(tabId, KNOBS.effort, eff);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, agentType, nativeBound]);
}
