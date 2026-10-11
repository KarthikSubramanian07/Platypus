/**
 * The plain content pages (about, developers, contact, privacy, 404). Each is written once in
 * content/<slug>.md; the build renders it into this HTML shell and also publishes the Markdown,
 * so the page a person reads and the page an agent reads can't drift apart.
 */
import { SITE_ORIGIN } from "../agent/negotiate";

export interface SitePage {
  slug: string;
  title: string;
  description: string;
  /** schema.org type for the page's JSON-LD. */
  schemaType: "AboutPage" | "ContactPage" | "WebPage" | "TechArticle";
  /** Unknown-path page: not indexed and not in the sitemap. */
  notFound?: boolean;
}

export const SITE_PAGES: readonly SitePage[] = [
  { slug: "about", title: "About Platypus", description: "Platypus is AI booking for phone-only businesses: one honest AI call makes a business bookable by every AI agent, by text.", schemaType: "AboutPage" },
  { slug: "developers", title: "Platypus for developers", description: "Connect any AI agent to phone-only businesses over MCP: quickstart, endpoint, the nine tools, booking outcomes and API keys.", schemaType: "TechArticle" },
  { slug: "contact", title: "Contact Platypus", description: "Reach the Platypus team on GitHub, opt a business out of calls and texts, or report a security problem.", schemaType: "ContactPage" },
  { slug: "privacy", title: "Privacy", description: "What the Platypus website and booking service store, why, and what we never do with it.", schemaType: "WebPage" },
  { slug: "404", title: "Page not found", description: "There is no page at this address on tryplatypus.pages.dev.", schemaType: "WebPage", notFound: true },
];

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ORGANIZATION = {
  "@type": "Organization",
  "@id": `${SITE_ORIGIN}/#org`,
  name: "Platypus",
  url: `${SITE_ORIGIN}/`,
  logo: `${SITE_ORIGIN}/favicon.svg`,
  sameAs: ["https://github.com/KarthikSubramanian07/Platypus"],
  address: { "@type": "PostalAddress", addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" },
  contactPoint: { "@type": "ContactPoint", contactType: "customer support", url: `${SITE_ORIGIN}/contact`, availableLanguage: "en" },
};

/** The JSON-LD for a page, escaped so it can't close its own script tag. */
export function pageJsonLd(page: SitePage): string {
  const graph = [ORGANIZATION, { "@type": page.schemaType, name: page.title, description: page.description, url: `${SITE_ORIGIN}/${page.slug}`, publisher: { "@id": `${SITE_ORIGIN}/#org` } }];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

/** A full HTML document for a content page, around already-rendered Markdown. */
export function renderPage(page: SitePage, bodyHtml: string): string {
  const url = `${SITE_ORIGIN}/${page.slug}`;
  const title = page.notFound ? `${page.title} · Platypus` : `${page.title} · Platypus, AI booking for phone-only businesses`;
  const robots = page.notFound ? `\n    <meta name="robots" content="noindex" />` : "";
  const alternates = page.notFound
    ? ""
    : `\n    <link rel="canonical" href="${url}" />\n    <link rel="alternate" type="text/markdown" href="${url}.md" title="This page as Markdown" />`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(page.description)}" />${robots}${alternates}
    <link rel="help" type="text/plain" href="${SITE_ORIGIN}/llms.txt" title="llms.txt" />
    <meta property="og:site_name" content="Platypus" />
    <meta property="og:title" content="${escapeHtml(page.title)}" />
    <meta property="og:description" content="${escapeHtml(page.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${SITE_ORIGIN}/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="theme-color" content="#F4F1EA" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script type="application/ld+json">${pageJsonLd(page)}</script>
  </head>
  <body class="doc-page">
    <nav class="nav" aria-label="Primary">
      <a class="brand" href="/" aria-label="Platypus home" title="Oh, there you are.">
        <span class="brand-mark" aria-hidden="true"><i class="fedora"></i></span>
        <span class="brand-word">platypus</span>
      </a>
      <div class="nav-links">
        <a class="nav-live" href="/live">Live demo</a>
        <a href="/technical">Technical</a>
        <a href="/business">Business</a>
        <a href="/developers"${page.slug === "developers" ? ' aria-current="page"' : ""}>Developers</a>
      </div>
      <a class="nav-source" href="https://github.com/KarthikSubramanian07/Platypus" rel="noopener">Source <span aria-hidden="true">↗</span></a>
    </nav>
    <main class="doc">
      <article class="prose">
${bodyHtml}
      </article>
      <aside class="doc-aside" aria-label="For agents">
        <p class="eyebrow">For agents</p>
        <p>This page is also Markdown: send <code>Accept: text/markdown</code>${page.notFound ? "" : `, or open <a href="/${page.slug}.md">/${page.slug}.md</a>`}. Start with <a href="/llms.txt">llms.txt</a>.</p>
      </aside>
    </main>
    <footer class="footer">
      <div class="footer-brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <p>A semi-aquatic, egg-laying agent of action.</p>
      </div>
      <nav class="footer-meta" aria-label="Footer">
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/developers">Developers</a>
        <a href="/contact">Contact</a>
        <a href="/privacy">Privacy</a>
        <a href="/llms.txt">llms.txt</a>
        <span>MIT · SpeedHacks SF, Oct 11, 2026</span>
      </nav>
    </footer>
    <script type="module" src="/src/page.ts"></script>
  </body>
</html>
`;
}
