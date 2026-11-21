/**
 * Types for `ci-placement.mjs`, which is plain Node ESM so `ci-local.mjs` (Bun)
 * and `doctor.mjs` (Node) can both import it. Declares the surface
 * `tests/ci-placement.test.ts` imports.
 */

export type LinuxMode = "native" | "needed" | "all";
export type Placement = "container" | "native" | "skip";

export interface PlacedJob {
  id: string;
  os: string;
  flags?: { sandbox?: boolean };
}

export const LINUX_MODES: LinuxMode[];
export const OS_BOUND: Set<string>;
export function hostOs(platform?: string): string;
export function needsLinux(job: PlacedJob): boolean;
export function linuxMode(
  argv: string[],
  env: Record<string, string | undefined>,
): { mode: LinuxMode; source: string };
export function placement(job: PlacedJob, host: string, mode: LinuxMode): Placement;
