import { defineConfig } from "vite";

const gateway = process.env.PLATYPUS_GATEWAY_URL ?? "http://localhost:8787";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/events": { target: gateway, changeOrigin: true },
      "/demo": { target: gateway, changeOrigin: true },
    },
  },
});
