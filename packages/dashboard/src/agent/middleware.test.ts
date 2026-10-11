import { describe, expect, it, vi } from "vitest";
import { onRequest, type PagesContext } from "../../functions/_middleware";

const ASSETS: Record<string, string> = { "/index.md": "# Platypus\n", "/about.md": "# About Platypus\n" };
const PAGES: Record<string, string> = { "/": "<!doctype html><h1>Platypus</h1>", "/about": "<!doctype html><h1>About</h1>" };

function context(path: string, accept?: string, method = "GET"): PagesContext & { next: ReturnType<typeof vi.fn> } {
  const url = `https://tryplatypus.pages.dev${path}`;
  const request = new Request(url, { method, headers: accept ? { Accept: accept } : {} });
  const next = vi.fn(async () => {
    const pathname = new URL(url).pathname;
    const html = PAGES[pathname];
    if (html) return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (pathname === "/llms.txt") return new Response("# Platypus", { headers: { "Content-Type": "text/plain" } });
    return new Response("<!doctype html><h1>Not found</h1>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
  const env = {
    ASSETS: {
      fetch: async (input: Request | URL | string) => {
        const pathname = new URL(input instanceof Request ? input.url : input).pathname;
        const body = ASSETS[pathname];
        return body ? new Response(body) : new Response("not found", { status: 404 });
      },
    },
  };
  return { request, env, next };
}

describe("Pages middleware", () => {
  it("answers Accept: text/markdown on the home page with Markdown and Vary: Accept", async () => {
    const res = await onRequest(context("/", "text/markdown"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(res.headers.get("Link")).toBe('<https://tryplatypus.pages.dev/>; rel="canonical"');
    expect(await res.text()).toBe("# Platypus\n");
  });

  it("keeps serving HTML to browsers, with Vary: Accept", async () => {
    const ctx = context("/", "text/html,application/xhtml+xml,*/*;q=0.8");
    const res = await onRequest(ctx);
    expect(ctx.next).toHaveBeenCalledOnce();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(await res.text()).toContain("<h1>Platypus</h1>");
  });

  it("negotiates every content page, not just the home page", async () => {
    const res = await onRequest(context("/about", "text/markdown"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# About Platypus\n");
  });

  it("returns a real 404 with a Markdown body for unknown paths", async () => {
    const res = await onRequest(context("/some-path-that-does-not-exist", "text/markdown"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.text();
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/some-path-that-does-not-exist");
  });

  it("passes the HTML 404 through for browsers", async () => {
    const res = await onRequest(context("/nope", "text/html"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves .md URLs as text/markdown, and a Markdown 404 when missing", async () => {
    const found = await onRequest(context("/about.md"));
    expect(found.status).toBe(200);
    expect(found.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const missing = await onRequest(context("/missing.md"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("# 404");
  });

  it("sends no body for HEAD", async () => {
    const res = await onRequest(context("/", "text/markdown", "HEAD"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("leaves non-page files and other methods untouched", async () => {
    const txt = context("/llms.txt", "text/markdown");
    const res = await onRequest(txt);
    expect(res.headers.get("Vary")).toBeNull();
    expect(await res.text()).toBe("# Platypus");
    const post = context("/", "text/markdown", "POST");
    await onRequest(post);
    expect(post.next).toHaveBeenCalledOnce();
  });
});
