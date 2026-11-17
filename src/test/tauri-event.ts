// What `vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"))`
// swaps in. See `tauri-fake.ts`.
import { event } from "./tauri-fake";

export const { listen, once, emit } = event;
