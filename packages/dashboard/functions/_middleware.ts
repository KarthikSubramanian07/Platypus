/**
 * Cloudflare Pages middleware: Markdown for agents, HTML for browsers, real 404s for both.
 * Every page path carries Vary: Accept. The rules live in src/agent/negotiate.ts.
 */
import { canonicalUrlFor, MARKDOWN_CONTENT_TYPE, markdownPathFor, notFoundMarkdown, prefersMarkdown } from "../src/agent/negotiate";

interface AssetFetcher {
  fetch(input: Request | URL | string): Promise<Response>;
}

export interface PagesContext {
  request: Request;
  env: { ASSETS: AssetFetcher };
  next(): Promise<Response>;
}

function markdownResponse(request: Request, body: string, status: number): Response {
  const url = new URL(request.url);
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
      ...(status === 200 ? { Link: `<${canonicalUrlFor(url.pathname)}>; rel="canonical"` } : {}),
    },
  });
}

function withVaryAccept(response: Response): Response {
  const headers = new Headers(response.headers);
  const vary = headers.get("Vary");
  if (!vary?.toLowerCase().split(/\s*,\s*/).includes("accept")) headers.set("Vary", vary ? `${vary}, Accept` : "Accept");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env, next } = context;
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const url = new URL(request.url);
  const wantsMarkdown = prefersMarkdown(request.headers.get("Accept"));

  // An explicit .md URL: serve the asset with the right type, or a Markdown 404.
  if (/\.md$/i.test(url.pathname)) {
    const asset = await env.ASSETS.fetch(new URL(url.pathname, url.origin));
    if (!asset.ok) return markdownResponse(request, notFoundMarkdown(url.pathname), 404);
    return markdownResponse(request, await asset.text(), 200);
  }

  const markdownPath = markdownPathFor(url.pathname);
  if (wantsMarkdown && markdownPath) {
    const asset = await env.ASSETS.fetch(new URL(markdownPath, url.origin));
    if (asset.ok) return markdownResponse(request, await asset.text(), 200);
    return markdownResponse(request, notFoundMarkdown(url.pathname), 404);
  }

  const response = await next();
  if (response.status === 404 && wantsMarkdown) return markdownResponse(request, notFoundMarkdown(url.pathname), 404);
  return markdownPath ? withVaryAccept(response) : response;
}
