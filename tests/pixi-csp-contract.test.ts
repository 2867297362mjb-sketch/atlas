import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, walk } from "./support/walk";
import { expectFloor } from "./support/floor";
import { stripTsComments } from "./support/ipc";

/**
 * Pixi starts under the app's content-security policy.
 *
 * Pixi 8 builds its shader and uniform-upload functions with `new Function`,
 * and a renderer's constructor checks for that before anything else: where
 * `eval` is refused, it throws "Current environment does not allow
 * unsafe-eval". The CSP in `src-tauri/tauri.conf.json` (`csp` and `devCsp`)
 * allows only `'wasm-unsafe-eval'`, so in the shipped app every graph's
 * `init()` rejected, and the Memory and Knowledge graphs drew their ruler over
 * an empty canvas. No gate saw it: `bun run dev` is a browser tab with no CSP,
 * where pixi draws fine, and the components swallowed the rejection.
 *
 * `pixi.js/unsafe-eval` swaps those builders for eval-free ones. It is
 * imported once, in `src/lib/pixi-app.ts`, which every Application already
 * goes through to be registered (`pixi-destroy-contract.test.ts` has why).
 * This suite pins both halves: the import stays there, and a module that
 * creates an Application imports that module, so a new graph cannot skip it.
 * Allowing `'unsafe-eval'` in the CSP instead would hand `eval` to every
 * script in the app.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");
const read = (file: string) => readFileSync(file, "utf8");

describe("pixi under the app's CSP", () => {
  it("src/lib/pixi-app.ts installs pixi's eval-free builders", () => {
    expect(
      read(path.join(SRC, "lib", "pixi-app.ts")),
      "pixi-app.ts must import pixi.js/unsafe-eval",
    ).toMatch(/^import\s+["']pixi\.js\/unsafe-eval["'];?\s*$/m);
  });

  it("every module that creates a pixi Application imports src/lib/pixi-app.ts", () => {
    // Comments are stripped first: `pixi-app.ts`'s own prose says
    // `new Application()`, and prose creates nothing.
    const creators = walk(SRC, [".ts", ".tsx"])
      .filter((file) => !isTestFile(file))
      .filter((file) => {
        const code = stripTsComments(read(file));
        return /from\s+["']pixi\.js["']/.test(code) && /\bnew\s+Application\s*\(/.test(code);
      });
    // The Memory and Knowledge graphs. The floor is what fails if the pattern
    // stops matching, instead of the loop below passing on nothing.
    expectFloor("modules under src/ that create a pixi Application", creators.length, 2);
    for (const file of creators) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      expect(
        read(file),
        `${rel} creates a pixi Application without importing @/lib/pixi-app`,
      ).toMatch(/from\s+["']@\/lib\/pixi-app["']/);
    }
  });
});
