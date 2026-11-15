/**
 * Payload of the `atlas:git-changed` Tauri channel: the git watcher saw a
 * commit, checkout, stage or other change under `project`. Mirrors
 * `GitChangedPayload` in `src-tauri/src/commands/git_watcher.rs`.
 *
 * A Tauri channel, not a window event: it is heard with `listen` from
 * `@tauri-apps/api/event` (window events are in `src/lib/window-events.ts`).
 */
export interface GitChangedPayload {
  /** The project root the change is under. */
  project: string;
}
