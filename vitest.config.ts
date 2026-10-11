import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each package is a project; "ci" covers the scripts under scripts/ci that the pipeline runs.
    projects: ["packages/*", { test: { name: "ci", include: ["scripts/ci/**/*.test.ts"] } }],
    coverage: {
      // Off unless `--coverage` is passed (`pnpm test:coverage`), so `pnpm test` stays fast.
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/test-helpers.ts",
        // Entry points that only start a process or a browser page; exercised by the e2e and smoke jobs.
        "packages/dashboard/src/main.ts",
        "packages/dashboard/src/live.ts",
        "packages/dashboard/src/page.ts",
      ],
      reporter: ["text-summary", "json-summary", "json", "html", "lcov"],
      reportsDirectory: "coverage",
      // Per-package floors, about two points under what the suite measured on 2026-10-11.
      // They only move up: raise a floor when a package's coverage rises, never lower one to land a change.
      thresholds: {
        "packages/shared/src/**": { lines: 93, statements: 90, functions: 93, branches: 81 },
        "packages/voice/src/**": { lines: 93, statements: 88, functions: 90, branches: 73 },
        "packages/text/src/**": { lines: 90, statements: 86, functions: 93, branches: 72 },
        "packages/gateway/src/**": { lines: 88, statements: 85, functions: 85, branches: 73 },
        "packages/dashboard/src/**": { lines: 87, statements: 81, functions: 86, branches: 72 },
      },
    },
  },
});
