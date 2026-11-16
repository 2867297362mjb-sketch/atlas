import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./support/walk";
import { expectFloor } from "./support/floor";

/**
 * The React Compiler contract.
 *
 * `vite.config.ts` runs the React Compiler over every component. It memoizes
 * by caching values in slots across renders, and it decides what may be
 * cached by the Rules of React: a call is a hook, and must run on every
 * render, only when the called name is `use` + a capital (`useX(...)`,
 * `obj.useX(...)`). Anything else is a plain call it may compute once and reuse.
 *
 * So a hook reached through a name that is not hook-shaped is cached after the
 * first render. React then sees fewer hooks than it saw before ("Rendered
 * fewer hooks", "Should have a queue"), and a store read stops updating. The
 * build is green, `tsc` is green, and before this suite the tests were green
 * too, because they ran uncompiled. The shape that did it was the generated
 * selector `useXStore.use.x()` (`createSelectors`), the store convention at
 * the time: the first compiled test run failed across dozens of files. It is
 * retired; read a store as `useXStore((s) => s.x)`.
 *
 * What this suite holds:
 *  - the compiler is on in BOTH `vite.config.ts` and `vitest.config.ts`. The
 *    second is what makes the first safe: a component the compiler breaks
 *    fails its own test instead of failing only in the shipped app;
 *  - no `.use.<name>(` selector call and no `createSelectors` under `src/`.
 *
 * A component the compiler cannot compile (a ref read in render, `try/finally`)
 * is skipped and runs exactly as it did uncompiled; only a fatal diagnostic
 * fails the build. To list the skipped ones, build with
 * `react({ compiler: { reportDiagnostics: true } })`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/** `useXStore.use.x(` — a hook behind the name `x`. `unified().use(plugin)` has no second dot. */
const GENERATED_SELECTOR = /\.use\.[A-Za-z_$][\w$]*\s*\(/;

describe("React Compiler contract", () => {
  it.each(["vite.config.ts", "vitest.config.ts"])("%s compiles components", (config) => {
    expect(
      read(config),
      `${config} must pass \`react({ compiler: true })\`. The app and its tests run the same compiled components or the tests prove nothing about the app.`,
    ).toMatch(/react\(\{\s*compiler:\s*true\s*\}\)/);
  });

  const files = walk(path.join(REPO_ROOT, "src"), [".ts", ".tsx"]);

  it("reads the tree", () => {
    expectFloor("TypeScript files under src/", files.length, 1350);
  });

  it("reads stores through a hook-shaped name", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (GENERATED_SELECTOR.test(line) || /\bcreateSelectors\b/.test(line)) {
            offenders.push(`${rel(file)}:${i + 1}`);
          }
        });
    }
    expect(
      offenders,
      "The React Compiler caches a call whose name is not `useX`, so `useXStore.use.x()` runs once and breaks hook order. Write `useXStore((s) => s.x)`.",
    ).toEqual([]);
  });
});
