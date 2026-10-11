import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pageJsonLd, renderPage, SITE_PAGES } from "./pages";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("content pages", () => {
  it("has a Markdown source for every page and for the home page", () => {
    for (const page of SITE_PAGES) expect(existsSync(resolve(root, "content", `${page.slug}.md`))).toBe(true);
    expect(existsSync(resolve(root, "content", "index.md"))).toBe(true);
  });

  it("publishes Markdown for the technical and business pages", () => {
    for (const slug of ["technical", "business"]) {
      expect(existsSync(resolve(root, `${slug}.html`))).toBe(true);
      expect(read(`content/${slug}.md`).length).toBeGreaterThan(500);
    }
  });

  it("gives the trust pages at least 500 characters of real content", () => {
    for (const slug of ["about", "contact", "privacy", "developers"]) expect(read(`content/${slug}.md`).length).toBeGreaterThan(500);
  });

  it("renders a complete, indexable HTML page", () => {
    const about = SITE_PAGES.find((p) => p.slug === "about")!;
    const html = renderPage(about, "<h1>About Platypus</h1>");
    expect(html).toContain("<title>About Platypus · Platypus, AI booking for phone-only businesses</title>");
    expect(html).toContain('<link rel="canonical" href="https://tryplatypus.pages.dev/about" />');
    expect(html).toContain('type="text/markdown" href="https://tryplatypus.pages.dev/about.md"');
    expect(html).not.toContain("noindex");
    expect(html).toContain("<h1>About Platypus</h1>");
  });

  it("keeps the 404 page out of the index", () => {
    const notFound = SITE_PAGES.find((p) => p.notFound)!;
    const html = renderPage(notFound, "<h1>Page not found</h1>");
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain('rel="canonical"');
  });

  it("publishes Organization JSON-LD with a contact point and a postal address", () => {
    const data = JSON.parse(pageJsonLd(SITE_PAGES[0]!)) as { "@graph": Array<Record<string, unknown>> };
    const org = data["@graph"].find((node) => node["@type"] === "Organization")!;
    expect(org.contactPoint).toMatchObject({ "@type": "ContactPoint", contactType: "customer support" });
    expect(org.address).toMatchObject({ "@type": "PostalAddress", addressLocality: "San Francisco", addressCountry: "US" });
  });

  it("puts the same Organization on the home page", () => {
    const html = read("index.html");
    const json = html.slice(html.indexOf('<script type="application/ld+json">') + 35, html.indexOf("</script>"));
    const graph = (JSON.parse(json) as { "@graph": Array<Record<string, unknown>> })["@graph"];
    expect(graph.find((node) => node["@type"] === "Organization")).toMatchObject({ contactPoint: { "@type": "ContactPoint" }, address: { "@type": "PostalAddress" } });
  });
});

describe("llms.txt", () => {
  const llms = read("public/llms.txt");

  it("follows the llmstxt.org layout: H1, blockquote summary, then H2 link lists", () => {
    const lines = llms.split("\n");
    expect(lines[0]).toBe("# Platypus");
    expect(llms).toMatch(/^> .+/m);
    expect(llms.match(/^# /gm)).toHaveLength(1);
    for (const section of llms.split(/^## /m).slice(1)) {
      const items = section.split("\n").slice(1).filter((l) => l.trim());
      for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\([^)]+\)(: .+)?$/);
    }
  });

  it("tells agents when to use Platypus", () => {
    expect(llms).toContain("## When to use Platypus");
    expect(llms).toContain("request_booking");
  });
});
