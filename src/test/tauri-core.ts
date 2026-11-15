// What `vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"))`
// swaps in. See `tauri-fake.ts`.
import { core } from "./tauri-fake";

export const { invoke, Channel, convertFileSrc, isTauri } = core;
