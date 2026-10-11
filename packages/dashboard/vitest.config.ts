import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "dashboard", include: ["src/**/*.test.ts"] },
});
