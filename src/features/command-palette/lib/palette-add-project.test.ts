import { describe, expect, it } from "vitest";
import { browseTarget, locationQuery, parentQuery, splitBrowseQuery } from "./palette-add-project";

describe("locationQuery", () => {
  it("opens home as ~/", () => {
    expect(locationQuery({ name: "Home", path: "C:\\Users\\me\\", kind: "home" })).toBe("~/");
  });

  it("opens a drive or volume at its root, which the browser lists", () => {
    const drive = locationQuery({ name: "F:", path: "F:\\", kind: "drive" });
    expect(drive).toBe("F:\\");
    expect(splitBrowseQuery(drive)).toEqual({ dir: "F:\\", filter: "" });
    const volume = locationQuery({ name: "Backup", path: "/Volumes/Backup/", kind: "removable" });
    expect(splitBrowseQuery(volume)).toEqual({ dir: "/Volumes/Backup/", filter: "" });
  });
});

describe("splitBrowseQuery", () => {
  it("splits a POSIX path at its last slash", () => {
    expect(splitBrowseQuery("~/code/at")).toEqual({ dir: "~/code/", filter: "at" });
  });

  it("splits a Windows path at its last backslash", () => {
    expect(splitBrowseQuery("F:\\server")).toEqual({ dir: "F:\\", filter: "server" });
    expect(splitBrowseQuery("F:\\server\\")).toEqual({ dir: "F:\\server\\", filter: "" });
  });

  it("splits a mixed path at whichever separator is last", () => {
    expect(splitBrowseQuery("F:\\server/apps")).toEqual({ dir: "F:\\server/", filter: "apps" });
  });

  it("reads a bare drive as its root", () => {
    expect(splitBrowseQuery("F:")).toEqual({ dir: "F:\\", filter: "" });
  });

  it("filters the home folder when no separator is typed", () => {
    expect(splitBrowseQuery("proj")).toEqual({ dir: "~/", filter: "proj" });
  });
});

describe("browseTarget", () => {
  it("adds the Windows folder typed, not the home folder", () => {
    expect(browseTarget("F:\\server")).toBe("F:\\server");
  });

  it("adds the folder listed when nothing is typed after it", () => {
    expect(browseTarget("~/code/")).toBe("~/code/");
  });

  it("keeps a typed name that is not listed, so resolving it can refuse it", () => {
    expect(browseTarget("~/code/missing")).toBe("~/code/missing");
  });
});

describe("parentQuery", () => {
  it("goes up a Windows path", () => {
    expect(parentQuery("F:\\server\\apps\\", null)).toBe("F:\\server\\");
    expect(parentQuery("F:\\server\\", null)).toBe("F:\\");
  });

  it("goes up a POSIX path", () => {
    expect(parentQuery("~/a/b/", null)).toBe("~/a/");
  });
});
