import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { defineConfig, type Plugin } from "vite";
import { renderPage, SITE_PAGES } from "./src/site/pages";

const gateway = process.env.PLATYPUS_GATEWAY_URL ?? "http://localhost:8787";
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const content = (slug: string) => readFileSync(page(`./content/${slug}.md`), "utf8");

/**
 * Renders content/<slug>.md into <slug>.html (a Vite entry, gitignored) and publishes the
 * Markdown next to it as <slug>.md, plus index.md for the landing page. 404.html makes
 * Cloudflare Pages answer unknown paths with a real 404 instead of the app shell.
 */
function contentPages(): Plugin {
  return {
    name: "platypus-content-pages",
    config() {
      const input: Record<string, string> = {};
      for (const site of SITE_PAGES) {
        const file = page(`./${site.slug}.html`);
        writeFileSync(file, renderPage(site, marked.parse(content(site.slug), { async: false })));
        input[site.slug] = file;
      }
      return { build: { rolldownOptions: { input } } };
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "index.md", source: content("index") });
      for (const site of SITE_PAGES) {
        if (!site.notFound) this.emitFile({ type: "asset", fileName: `${site.slug}.md`, source: content(site.slug) });
      }
    },
  };
}

export default defineConfig({
  // The landing page at /, the operator dashboard at /live, and the content pages.
  // Cloudflare Pages serves live.html at the clean URL /live, and Vite's dev and preview servers do the same.
  appType: "mpa",
  plugins: [contentPages()],
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
