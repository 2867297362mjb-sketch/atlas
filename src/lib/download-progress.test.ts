import { describe, expect, it } from "vitest";
import { downloadPercent, type DownloadProgress } from "./download-progress";

const at = (over: Partial<DownloadProgress>): DownloadProgress => ({
  id: "all-minilm-l6-v2",
  file: "model.safetensors",
  fileIndex: 0,
  fileCount: 3,
  received: 0,
  total: 0,
  ...over,
});

describe("downloadPercent", () => {
  it("reads the payload as Rust spells it", () => {
    // The regression: the Memory tab read `file_index` off this payload, got
    // `undefined`, and showed `NaN%` for the whole download.
    const wire = JSON.parse(
      '{"id":"all-minilm-l6-v2","file":"model.safetensors","fileIndex":2,"fileCount":3,"received":45450000,"total":90900000}',
    ) as DownloadProgress;
    expect(downloadPercent(wire)).toBe(83);
  });

  it("counts the files before this one, plus this one's share", () => {
    expect(downloadPercent(at({ fileIndex: 0, received: 0, total: 612 }))).toBe(0);
    expect(downloadPercent(at({ fileIndex: 1, received: 347_500, total: 695_000 }))).toBe(50);
  });

  it("counts a file of unknown length as not started", () => {
    expect(downloadPercent(at({ fileIndex: 1, received: 4_194_304, total: 0 }))).toBe(33);
  });

  it("reaches 100 when the last file finishes", () => {
    expect(downloadPercent(at({ fileIndex: 2, received: 90_900_000, total: 90_900_000 }))).toBe(
      100,
    );
  });

  it("never passes 100, even when a file outruns its stated length", () => {
    expect(downloadPercent(at({ fileIndex: 2, received: 120, total: 100 }))).toBe(100);
  });

  it("is a number when there are no files", () => {
    expect(downloadPercent(at({ fileCount: 0 }))).toBe(0);
  });
});
