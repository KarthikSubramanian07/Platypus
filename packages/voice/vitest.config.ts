import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "voice", include: ["src/**/*.test.ts"] },
});
