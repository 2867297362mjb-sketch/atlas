/**
 * A model download's progress, as Rust's shared downloader emits it
 * (`DownloadProgress` in `src-tauri/src/commands/models.rs`, camelCase on the
 * wire). The one struct feeds two channels, `atlas:model-download:progress`
 * (Settings ▸ Models) and `atlas:memory-embed:progress` (the Memory tab's
 * download screens), so both read this one type. The Memory tab once kept its
 * own snake_case copy, read `file_index` off a payload that only ever carries
 * `fileIndex`, and showed `NaN%`. `tests/wire-shape-contract.test.ts` (#18)
 * holds this to the Rust struct.
 */
export interface DownloadProgress {
  /** The model's id, so one listener can route progress. */
  id: string;
  /** The file being fetched, by its name on disk. */
  file: string;
  /** `file`'s 0-based position among the `fileCount` files. */
  fileIndex: number;
  fileCount: number;
  /** Bytes of `file` received so far. */
  received: number;
  /** `file`'s size in bytes; 0 when the server sent no length. */
  total: number;
}

/**
 * How far through the whole download, 0–100: the files before this one, plus
 * this one's share. A file of unknown length counts as not started until its
 * last event, which reports `total` as the bytes received.
 */
export function downloadPercent(p: DownloadProgress): number {
  const current = p.total > 0 ? Math.min(1, p.received / p.total) : 0;
  return Math.min(100, Math.round(((p.fileIndex + current) / Math.max(1, p.fileCount)) * 100));
}
