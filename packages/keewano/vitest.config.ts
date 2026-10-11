import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "keewano", include: ["src/**/*.test.ts"] },
});
