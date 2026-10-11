import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const gateway = process.env.PLATYPUS_GATEWAY_URL ?? "http://localhost:8787";
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  // Two pages: the landing page at / and the operator dashboard at /live.
  // Cloudflare Pages serves live.html at the clean URL /live, and Vite's dev and preview servers do the same.
  appType: "mpa",
  build: {
    rolldownOptions: {
      input: { main: page("./index.html"), live: page("./live.html") },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/events": { target: gateway, changeOrigin: true },
      "/demo": { target: gateway, changeOrigin: true },
    },
  },
});
