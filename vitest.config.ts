import { defineConfig } from "vitest/config";
import path from "path";

// Deliberately standalone rather than extending `vite.config.ts`. That config
// carries the dev-server warmup list, `optimizeDeps` pre-bundling and the
// Rollup chunk splitter — all of it irrelevant to tests, and all of it work
// Vitest would redo on every run. Tests only need the `@` alias.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // In the checkout, not the default `node_modules/.vitest-cache`: worktrees
    // symlink one `node_modules`, so they all shared that directory, and two
    // runs at once failed each other with ENOTEMPTY or ENOENT on it.
    fsModuleCachePath: path.resolve(import.meta.dirname, ".vitest-cache"),
    // `node` by default: the contract tests read the repo off disk and the
    // API-seam tests only need a mocked `invoke`. Files that need a DOM opt in
    // per-file with `// @vitest-environment happy-dom`.
    environment: "node",
    // Both pinned so a test sees the same world on every machine. CI runs in
    // UTC while developers don't, and a fixture built from "now" landed on the
    // wrong side of midnight only on the runner (6eb12da5).
    env: { TZ: "UTC" },
    environmentOptions: {
      happyDOM: {
        settings: {
          navigator: {
            // happy-dom derives its default user agent from `process.platform`,
            // so `src/lib/platform.ts` reported Linux on CI and nothing on a
            // Mac: a test rendering a shortcut label could pass locally and fail
            // there. This UA names no OS, as a Mac run always saw; a test that
            // needs one mocks `@/lib/platform`, as combo-linux.test.ts does.
            userAgent: "Mozilla/5.0 (X11) AppleWebKit/537.36 (KHTML, like Gecko) HappyDOM",
          },
        },
      },
    },
    include: ["tests/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    // `bun run test:coverage` only; no threshold, on purpose. A number to
    // hit rewards tests that execute lines without checking behaviour. The
    // report is for finding code no test reaches at all. `include` makes
    // files no test imports count as 0% instead of going missing.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/bindings/**",
        "src/dev/**",
        "src/**/*.gen.ts",
        "src/**/*.d.ts",
      ],
    },
    server: {
      deps: {
        // The package's TimelineCalendar, run through Vite rather than loaded
        // by Node, so its own `@tanstack/react-virtual` and `motion/react`
        // imports see a test file's `vi.mock`s. The board and inbox tests make
        // the virtualizer total that way: in happy-dom every element measures
        // zero, and the real one renders no rows. Only this entry: inlining the
        // whole package would hand every primitive those mocks too.
        inline: [/@tryatlas\/design\/dist\/components\/blocks\/timeline-calendar/],
      },
    },
    // The workspace `target/` holds vendored dependency sources; without
    // this Vitest walks 38 GB of build artifacts.
    exclude: ["**/node_modules/**", "**/target/**", "**/dist/**"],
  },
});
