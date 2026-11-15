/**
 * The one-shot boot of the Rust-owned `AppState`: read `state.json`, hand it
 * to the stores, and decide whether this session may write it back.
 *
 * That last decision is why this is a module with its dependencies passed in,
 * rather than an effect: `bootstrap_app_state` is the only read of
 * `state.json` Atlas ever performs, the stores hold empty defaults until it
 * delivers, and `AppState::apply_patch` replaces the persisted lists
 * wholesale. A session that came up without the snapshot and still saved
 * would write that emptiness over the user's projects and organisations.
 * So persistence is enabled in exactly one place, on the success path, and
 * every other path (a failed load, a cancelled one, one that never settles)
 * leaves it off. `start-app-boot.ts` is the production wiring.
 */
import type { AppStateWire } from "../stores/app-store";

/** How many times the load is tried before the session comes up read-only. */
export const BOOT_LOAD_ATTEMPTS = 3;
/** The pause after a failed attempt is this times the attempt's number. */
export const BOOT_RETRY_STEP_MS = 150;

export interface BootSequenceDeps {
  /** The folder a terminal `atlas <path>` launch asked for, taken once. */
  takeCliPath: () => Promise<string | null>;
  /** One attempt at reading the saved state. Rejects when it fails. */
  loadState: () => Promise<AppStateWire>;
  wait: (ms: number) => Promise<void>;
  /** Runs `apply` now, as a non-urgent update (`startTransition`). */
  transition: (apply: () => void) => void;
  /** Allow or deny writing the app state back to disk. */
  enablePersistence: (enabled: boolean) => void;
  /** Hand the loaded state to the stores. */
  applyState: (state: AppStateWire, opts: { skipActiveSwitch: boolean }) => void;
  /** Bring the stores up empty, for a session that could not load. */
  applyEmptyState: (opts: { skipActiveSwitch: boolean }) => void;
  /** Tell the user, and the log, that the saved state could not be loaded. */
  reportLoadFailure: () => void;
  /** Add the CLI launch's folder as a project and switch to it. */
  openCliProject: (path: string) => Promise<void>;
  /** The boot is over, loaded or not: the boot skeleton can go. */
  ready: () => void;
}

/**
 * Run the boot. Returns a cancel function (the effect's cleanup): a boot
 * cancelled before its load settles applies nothing and enables nothing.
 *
 * The steps, in order:
 *
 *   1. take the CLI launch's folder, BEFORE loading: applying the state
 *      replaces the project list and fires its own switch, which would both
 *      clobber the CLI project and swallow its switch. With a folder, the
 *      state is applied without its switch and the folder is the only one;
 *   2. load the state, retrying: a transient IPC failure shouldn't cost a
 *      session;
 *   3. loaded: enable persistence, then apply the state, in one transition.
 *      Not loaded: deny persistence, report it, and apply the empty state;
 *   4. open the CLI folder, only when the state loaded: without it there is
 *      no organisation to own the project;
 *   5. signal ready, whichever way step 3 went.
 */
export function runBootSequence(deps: BootSequenceDeps): () => void {
  let cancelled = false;

  void (async () => {
    const cliPath = await deps.takeCliPath().catch(() => null);
    const skipActiveSwitch = !!cliPath;

    let state: AppStateWire | null = null;
    for (let attempt = 1; attempt <= BOOT_LOAD_ATTEMPTS && !state; attempt++) {
      try {
        state = await deps.loadState();
      } catch (e) {
        console.warn(`bootstrap_app_state attempt ${attempt} failed:`, e);
        if (attempt < BOOT_LOAD_ATTEMPTS) await deps.wait(BOOT_RETRY_STEP_MS * attempt);
      }
    }
    if (cancelled) return;

    try {
      if (state) {
        const loaded = state;
        deps.transition(() => {
          // The stores are about to hold the user's real state, so writing
          // them back is safe from here on. Before this line they hold empty
          // defaults and persistence is denied.
          deps.enablePersistence(true);
          deps.applyState(loaded, { skipActiveSwitch });
        });
      } else {
        // Every attempt failed. Come up in an explicitly READ-ONLY session
        // rather than letting the empty stores overwrite `state.json`: the
        // user's projects and orgs are still on disk, and a restart is what
        // brings them back. Without this the app looks merely "empty" and
        // then makes that permanent on quit.
        deps.enablePersistence(false);
        deps.reportLoadFailure();
        deps.transition(() => deps.applyEmptyState({ skipActiveSwitch }));
      }
    } finally {
      if (!cancelled) {
        // Without a loaded state `addProject` would refuse anyway, and its
        // "no organisation" toast would bury the boot-failure one that
        // actually tells the user what to do.
        if (cliPath && state) await deps.openCliProject(cliPath);
        deps.ready();
      }
    }
  })();

  return () => {
    cancelled = true;
  };
}
