import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPage, SITE_PAGES } from "./site/pages";
import { describe, expect, it } from "vitest";

/**
 * Event text is untrusted: owner replies, agent requests, Darwin's descriptions
 * of third parties. The pages build DOM with textContent only (see dom.ts), so
 * no source file may reach for an HTML-parsing sink.
 */
describe("dashboard sources", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("never parse event text as HTML", () => {
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      const code = readFileSync(join(dir, file), "utf8");
      expect(code, file).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|createContextualFragment/);
    }
  });
});

/** Every header rule in public/_headers for one path pattern, as name -> value. */
function headersFor(pattern: string): Record<string, string> {
  const text = readFileSync(join(import.meta.dirname, "..", "public", "_headers"), "utf8");
  const out: Record<string, string> = {};
  let current = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) current = line.trim();
    else if (current === pattern) {
      const [name, ...value] = line.trim().split(":");
      out[name!.toLowerCase()] = value.join(":").trim();
    }
  }
  return out;
}

describe("security headers (public/_headers, served by Cloudflare Pages)", () => {
  const headers = headersFor("/*");
  const csp = Object.fromEntries(
    (headers["content-security-policy"] ?? "").split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]),
  ) as Record<string, string[]>;

  it("sets a strict Content-Security-Policy: own scripts only, no plugins, no framing", () => {
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["style-src"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(headers["content-security-policy"]).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it("lets the event stream reach this site, a local server or a cloudflared tunnel, and nothing else", () => {
    expect(csp["connect-src"]).toEqual(["'self'", "http://localhost:*", "http://127.0.0.1:*", "https://*.trycloudflare.com"]);
  });

  it("sets the companion headers", () => {
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["permissions-policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  });

  it("fits every page: no inline script or event handler, no third-party script, style or font", () => {
    const pages = [
      readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8"),
      readFileSync(join(import.meta.dirname, "..", "live.html"), "utf8"),
      ...SITE_PAGES.map((page) => renderPage(page, "<p>body</p>")),
    ];
    for (const html of pages) {
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
        // Module scripts load from this origin; JSON-LD is data, never executed.
        expect(tag).toMatch(/type="module"[^>]*src="\/|type="application\/ld\+json"/);
      }
      expect(html).not.toMatch(/<script type="module">|\son[a-z]+="|javascript:/i);
      expect(html).not.toMatch(/<(?:link|script)[^>]+(?:href|src)="https?:\/\/(?!tryplatypus\.pages\.dev)[^"]*"[^>]*>/);
    }
  });
});
