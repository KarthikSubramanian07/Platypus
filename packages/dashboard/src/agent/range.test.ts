import { describe, expect, it } from "vitest";
import { onRequest, type PagesContext } from "../../functions/_middleware";
import { resolveRange } from "./range";

describe("resolveRange", () => {
  it("returns the whole file without a Range header", () => {
    expect(resolveRange(null, 100)).toEqual({ kind: "full" });
    expect(resolveRange("items=0-1", 100)).toEqual({ kind: "full" });
  });

  it("resolves open, closed and suffix ranges", () => {
    expect(resolveRange("bytes=0-", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(resolveRange("bytes=10-19", 100)).toEqual({ kind: "partial", start: 10, end: 19 });
    expect(resolveRange("bytes=90-500", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(resolveRange("bytes=-10", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
  });

  it("refuses ranges past the end", () => {
    expect(resolveRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(resolveRange("bytes=20-10", 100)).toEqual({ kind: "unsatisfiable" });
    expect(resolveRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("Pages middleware, media", () => {
  const film = new Uint8Array(1000).map((_, i) => i % 256);
  const context = (range?: string, method = "GET"): PagesContext => ({
    request: new Request("https://tryplatypus.pages.dev/media/platypus-film.mp4", { method, headers: range ? { Range: range } : {} }),
    env: { ASSETS: { fetch: async () => new Response(film, { headers: { "Content-Type": "video/mp4" } }) } },
    next: async () => new Response("unreachable", { status: 500 }),
  });

  it("answers a byte range with 206 and exactly those bytes, so the player can seek", async () => {
    const res = await onRequest(context("bytes=100-199"));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body[0]).toBe(100);
  });

  it("serves the whole file with Accept-Ranges when no range is asked", async () => {
    const res = await onRequest(context());
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  it("returns 416 past the end, and no body for HEAD", async () => {
    const past = await onRequest(context("bytes=5000-"));
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */1000");
    const head = await onRequest(context("bytes=0-9", "HEAD"));
    expect(head.status).toBe(206);
    expect(await head.text()).toBe("");
  });
});
