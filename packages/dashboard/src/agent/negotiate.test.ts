import { describe, expect, it } from "vitest";
import { canonicalUrlFor, markdownPathFor, notFoundMarkdown, parseAccept, prefersMarkdown } from "./negotiate";

describe("parseAccept", () => {
  it("reads media types and quality values", () => {
    expect(parseAccept("text/markdown;q=0.9, text/html")).toEqual([
      { type: "text/markdown", q: 0.9 },
      { type: "text/html", q: 1 },
    ]);
  });

  it("treats a missing or malformed header as no preference", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept("text/html;q=abc")).toEqual([{ type: "text/html", q: 0 }]);
  });
});

describe("prefersMarkdown", () => {
  it("serves Markdown when it is asked for explicitly", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html")).toBe(true);
    expect(prefersMarkdown("text/html;q=0.8, text/markdown")).toBe(true);
  });

  it("keeps browsers and wildcard clients on HTML", () => {
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
  });
});

describe("markdownPathFor", () => {
  it("maps page paths to their Markdown asset", () => {
    expect(markdownPathFor("/")).toBe("/index.md");
    expect(markdownPathFor("/index.html")).toBe("/index.md");
    expect(markdownPathFor("/about")).toBe("/about.md");
    expect(markdownPathFor("/about/")).toBe("/about.md");
    expect(markdownPathFor("/developers.html")).toBe("/developers.md");
    expect(markdownPathFor("/no/such/page")).toBe("/no/such/page.md");
  });

  it("leaves files that aren't pages alone", () => {
    expect(markdownPathFor("/llms.txt")).toBeNull();
    expect(markdownPathFor("/og.png")).toBeNull();
    expect(markdownPathFor("/about.md")).toBeNull();
    expect(markdownPathFor("/assets/main-123.js")).toBeNull();
  });
});

describe("canonicalUrlFor", () => {
  it("points the Markdown variant at its HTML page", () => {
    expect(canonicalUrlFor("/")).toBe("https://tryplatypus.pages.dev/");
    expect(canonicalUrlFor("/index.md")).toBe("https://tryplatypus.pages.dev/");
    expect(canonicalUrlFor("/about.md")).toBe("https://tryplatypus.pages.dev/about");
    expect(canonicalUrlFor("/about/")).toBe("https://tryplatypus.pages.dev/about");
  });
});

describe("notFoundMarkdown", () => {
  it("explains the error and points agents at llms.txt, the docs and the sitemap", () => {
    const body = notFoundMarkdown("/nope");
    expect(body).toContain("# 404");
    expect(body).toContain("`/nope`");
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/developers.md");
    expect(body).toContain("/sitemap.xml");
    expect(body.length).toBeGreaterThan(20);
  });

  it("can't be broken out of its code span or blown up by a huge path", () => {
    expect(notFoundMarkdown("/a`b")).toContain("`/ab`");
    expect(notFoundMarkdown(`/${"x".repeat(5000)}`).length).toBeLessThan(1500);
  });
});
