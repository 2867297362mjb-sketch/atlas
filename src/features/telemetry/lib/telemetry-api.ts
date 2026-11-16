// Thin IPC wrapper over `src-tauri/src/commands/telemetry.rs`.

import { invoke } from "@tauri-apps/api/core";

export interface TelemetryConfig {
  enabled: boolean;
  host: string;
  /** Device-stable anonymous id (Rust's `device.json`). */
  anonId: string;
  /** Atlas account id when already signed in at boot, else null. */
  accountId: string | null;
  usingDefaultKey: boolean;
  /** Write-only project key, or null on an inert build (→ posthog never inits). */
  key: string | null;
}

export function telemetryConfig(): Promise<TelemetryConfig> {
  return invoke<TelemetryConfig>("telemetry_config");
}
