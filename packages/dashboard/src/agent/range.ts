/**
 * Byte ranges for media (RFC 9110, 14). Browsers seek a <video> by asking for byte ranges;
 * a server that answers every range with the whole file makes the scrubber useless.
 */
export type RangeResult = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/** Resolves a Range header against a file of `size` bytes. Only single ranges; anything else is the full file. */
export function resolveRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  if (m[1] === "") {
    // A suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}

export const MEDIA_PATH = /\.(mp4|webm|m4v|mov)$/i;
