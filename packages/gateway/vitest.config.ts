import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "gateway", include: ["src/**/*.test.ts"] },
});
