/**
 * The app's boot, started once at app scope. Production wiring for
 * `boot-sequence.ts`: it hands the sequence its real dependencies (the
 * `bootstrap_app_state` command, the stores, the write gate in the app
 * store) and returns the cancel function for the effect's cleanup.
 *
 * Until the load resolves (~5–20 ms warm) the WelcomeScreen and the
 * project-aware panels render their empty/loading states.
 */
import { startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { logEvent } from "@/features/log/lib/log";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { primeMarkdown } from "@/lib/markdown";
import { primeMarkdownRenderer } from "@/lib/markdown-cache";
import { emitWindowEvent } from "@/lib/window-events";
import { setAppStateWritable, useAppStore, type AppStateWire } from "../stores/app-store";
import { runBootSequence } from "./boot-sequence";

/** Dispatch `atlas:app-ready` once: the inline script in `index.html`
 *  listens for it and removes the boot skeleton. */
function signalReady(): void {
  const flag = window as unknown as { __atlasAppReady?: boolean };
  if (flag.__atlasAppReady) return;
  flag.__atlasAppReady = true;
  emitWindowEvent("atlas:app-ready");
}

export function startAppBoot(): () => void {
  return runBootSequence({
    // Rust stashes the path single-shot, so a window reload won't re-trigger.
    takeCliPath: () => invoke<string | null>("cli_take_initial_project_path"),
    loadState: () => invoke<AppStateWire>("bootstrap_app_state"),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Marks the welcome → project layout swap as non-urgent, so React can
    // pause reconciliation between component subtrees and keep the welcome
    // UI interactive while the project layout mounts.
    transition: startTransition,
    enablePersistence: setAppStateWritable,
    applyState: (state, opts) => {
      useAppStore.getState().actions.hydrate(state, opts);
      // Hydration replaces the org list wholesale, so re-apply any server
      // orgs from a snapshot that may have already arrived — otherwise a
      // sign-in that landed before this bootstrap would be overwritten.
      const snap = useAuthStore.getState().snapshot;
      if (snap.status === "signed-in" && snap.orgs) {
        useOrgStore.getState().actions.mergeServerOrgs(snap.orgs);
      }
    },
    applyEmptyState: (opts) => {
      useAppStore
        .getState()
        .actions.hydrate({ currentProject: null, recentProjects: [], version: 1 }, opts);
    },
    reportLoadFailure: () => {
      logEvent({
        source: "atlas",
        kind: "bootstrap-failed",
        summary: "bootstrap_app_state failed after 3 attempts; app-state writes suspended",
        status: "failure",
      });
      toast.error(
        "Atlas couldn't load your projects. Your saved data is safe on disk — restart Atlas to get it back.",
        { duration: Infinity },
      );
    },
    openCliProject: async (path) => {
      logEvent({
        source: "atlas",
        kind: "cli-launch-open-project",
        summary: `Adding project from CLI argv: ${path}`,
        status: "success",
        payload: { path },
      });
      await useAppStore
        .getState()
        .actions.openProject(path)
        .catch((err) => {
          logEvent({
            source: "atlas",
            kind: "cli-launch-open-project-failed",
            summary: `openProject failed: ${String(err)}`,
            status: "failure",
            payload: { error: String(err) },
          });
        });
    },
    ready: () => {
      signalReady();
      // First paint is done — pull in the main-thread markdown renderer now
      // so the first small chat block still parses synchronously. It is
      // deliberately NOT a static import (it would land in the eager entry
      // chunk); see `primeMarkdownRenderer`.
      primeMarkdownRenderer();
      primeMarkdown();
    },
  });
}
