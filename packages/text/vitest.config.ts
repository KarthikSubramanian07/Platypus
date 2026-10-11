import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "text", include: ["src/**/*.test.ts"] },
});
