/**
 * Markdown content negotiation for agents (acceptmarkdown.com): a request whose Accept
 * header prefers text/markdown gets the page as Markdown, everyone else gets HTML, and
 * both carry Vary: Accept so caches keep them apart. Pure functions, so the Pages
 * middleware stays a thin adapter and every rule here is unit tested.
 */
export const SITE_ORIGIN = "https://tryplatypus.pages.dev";
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

interface MediaRange {
  type: string;
  q: number;
}

/** Parses an Accept header into media ranges with their quality values (RFC 9110, 12.5.1). */
export function parseAccept(header: string | null | undefined): MediaRange[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [type = "", ...params] = part.trim().split(";").map((p) => p.trim());
      const qParam = params.find((p) => p.toLowerCase().startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { type: type.toLowerCase(), q: Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 0 };
    })
    .filter((range) => range.type.length > 0);
}

/**
 * True when the client explicitly asks for Markdown at least as much as it asks for HTML.
 * Wildcards never select Markdown on their own, so browsers (text/html first, then *\/*)
 * keep getting HTML.
 */
export function prefersMarkdown(header: string | null | undefined): boolean {
  const ranges = parseAccept(header);
  const quality = (type: string) => Math.max(0, ...ranges.filter((r) => r.type === type).map((r) => r.q));
  const markdown = quality("text/markdown");
  return markdown > 0 && markdown >= quality("text/html");
}

const PAGE_EXTENSION = /\.html?$/i;
const OTHER_EXTENSION = /\.[a-z0-9]+$/i;

/**
 * The Markdown asset for a page path, or null when the path is a file that isn't a page
 * (an image, llms.txt, an existing .md). "/" maps to "/index.md"; "/about", "/about/" and
 * "/about.html" map to "/about.md".
 */
export function markdownPathFor(pathname: string): string | null {
  let path = pathname.replace(PAGE_EXTENSION, "");
  if (OTHER_EXTENSION.test(path)) return null;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "" || path === "/" || path === "/index") return "/index.md";
  return `${path}.md`;
}

/** The canonical HTML URL for a page path, for the Markdown variant's Link header. */
export function canonicalUrlFor(pathname: string): string {
  const path = pathname.replace(PAGE_EXTENSION, "").replace(/\.md$/i, "").replace(/\/index$/, "/");
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : "/";
  return `${SITE_ORIGIN}${clean}`;
}

/** The Markdown body for an unknown path: what happened, and where an agent should look instead. */
export function notFoundMarkdown(pathname: string): string {
  const shown = pathname.length > 200 ? `${pathname.slice(0, 200)}…` : pathname;
  return [
    "# 404: page not found",
    "",
    `There is no page at \`${shown.replace(/`/g, "")}\` on tryplatypus.pages.dev.`,
    "",
    "Where to look instead:",
    "",
    `- [llms.txt](${SITE_ORIGIN}/llms.txt): what Platypus is, when to use it, and every page on this site.`,
    `- [Developer guide](${SITE_ORIGIN}/developers.md): the MCP endpoint, the ten tools and booking outcomes.`,
    `- [Sitemap](${SITE_ORIGIN}/sitemap.xml): every HTML page.`,
    `- [Home](${SITE_ORIGIN}/index.md): the product in Markdown.`,
    "",
  ].join("\n");
}
