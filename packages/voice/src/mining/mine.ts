import { maskNumber } from "@platypus/shared/config";
import { sanitizeUntrustedText } from "@platypus/shared/safety";
import { localParts } from "../call/time";
import { anthropicFromEnv, mineWithClaude, type AnthropicLike } from "./claude";
import {
  AI_Q_RE,
  DNC_RE,
  findHours,
  findLeadTimes,
  findOwnerName,
  findPrices,
  findSpokenPhone,
  findTimes,
  friction,
  NO_RE,
  THIS_LINE_RE,
  VOICEMAIL_RE,
  WRONG_RE,
  YES_RE,
  type Friction,
  type TimedTurn,
} from "./deterministic";
import type { Finding } from "./types";

export interface MineOptions {
  /** A client, null to stay deterministic, or undefined to use ANTHROPIC_API_KEY when it is set. */
  anthropic?: AnthropicLike | null;
  /** The booking window, so "two o'clock" lands inside it. */
  window?: { startIso: string; endIso: string; timeZone: string };
}

export interface MineResult {
  findings: Finding[];
  friction: Friction;
  claude: { used: boolean; error?: string };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const bump = (c: number, by: number) => Math.min(0.98, Math.round((c + by) * 100) / 100);

/** The agent turn just before turn i, if the previous non-empty turn was the agent's. */
function previousAgentTurn(turns: readonly TimedTurn[], i: number): TimedTurn | undefined {
  const prev = turns[i - 1];
  return prev && prev.speaker === "agent" ? prev : undefined;
}

/**
 * Mines a finished call's transcriptTurns. Deterministic first; then, if a
 * Claude client is available, adds what the patterns missed (each Claude item
 * must quote its turn verbatim). Never confirms anything: callers emit each
 * finding as a transcript.mined event with its confidence.
 */
export async function mineTranscript(turns: readonly TimedTurn[], options: MineOptions = {}): Promise<MineResult> {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "method" | "quote"> & { quote: string }) =>
    findings.push({ ...f, quote: sanitizeUntrustedText(f.quote), method: "deterministic" });

  // Which meridiem a bare "two o'clock" means: the window's, when we know it.
  let windowHours: { start: number; end: number } | null = null;
  if (options.window) {
    const s = localParts(new Date(options.window.startIso), options.window.timeZone);
    const e = localParts(new Date(options.window.endIso), options.window.timeZone);
    windowHours = { start: s.hour + s.minute / 60, end: e.date === s.date ? e.hour + e.minute / 60 : 24 };
  }
  const defaultMeridiem = windowHours && windowHours.end <= 12 ? "am" : "pm";
  const agentSays = (from: number) => turns.slice(from + 1).filter((t) => t.speaker === "agent");

  const seenPrices = new Set<number>();
  const seenTimes = new Set<string>();
  let userTurnsSeen = 0;

  turns.forEach((turn, i) => {
    if (turn.speaker !== "user") return;
    userTurnsSeen++;
    const text = turn.text;
    const asked = previousAgentTurn(turns, i);
    const askedNorm = asked ? norm(asked.text) : "";

    // Consent: the owner's answer to the consent question, quoted exactly.
    if (askedNorm.includes("text you instead")) {
      const value = NO_RE.test(text) ? "no" : YES_RE.test(text) ? "yes" : "unclear";
      add({ kind: "consent_sentence", value, quote: text, turnIndex: i, confidence: value === "unclear" ? 0.5 : 0.95 });
    }

    // The cell to text: "this one" means the line we called.
    if (askedNorm.includes("best cell")) {
      const spoken = findSpokenPhone(text);
      if (THIS_LINE_RE.test(text)) add({ kind: "text_number", value: "this_line", quote: text, turnIndex: i, confidence: 0.9 });
      else if (spoken) add({ kind: "text_number", value: maskNumber(spoken), quote: text, turnIndex: i, confidence: 0.85 });
    }

    for (const p of findPrices(text)) {
      if (seenPrices.has(p.cents)) continue;
      seenPrices.add(p.cents);
      const repeated = agentSays(i).some((a) => findPrices(a.text).some((q) => q.cents === p.cents));
      add({ kind: "price", value: p.cents, quote: text, turnIndex: i, confidence: bump(p.approximate ? 0.7 : 0.9, repeated ? 0.05 : 0) });
    }

    for (const t of findTimes(text, { defaultMeridiem })) {
      let hour = t.hour24;
      if (!t.explicit && windowHours) {
        const inside = (h: number) => h + t.minute / 60 >= windowHours!.start && h + t.minute / 60 < windowHours!.end;
        if (!inside(hour) && hour < 12 && inside(hour + 12)) hour += 12;
        else if (!inside(hour) && hour >= 12 && inside(hour - 12)) hour -= 12;
      }
      const value = hhmm(hour, t.minute);
      if (seenTimes.has(value)) continue;
      seenTimes.add(value);
      const repeated = agentSays(i).some((a) => findTimes(a.text, { defaultMeridiem }).some((q) => q.hour24 === hour && q.minute === t.minute));
      add({ kind: "slot_time", value, quote: text, turnIndex: i, confidence: bump(t.explicit ? 0.9 : 0.8, repeated ? 0.05 : 0) });
    }

    for (const d of findLeadTimes(text)) add({ kind: "lead_time", value: d.minutes, quote: text, turnIndex: i, confidence: 0.7 });
    for (const h of findHours(text)) add({ kind: "hours", value: h.text, quote: text, turnIndex: i, confidence: 0.75 });

    if (userTurnsSeen <= 2) {
      const name = findOwnerName(text);
      if (name) add({ kind: "owner_name", value: name, quote: text, turnIndex: i, confidence: 0.8 });
      if (WRONG_RE.test(text)) add({ kind: "wrong_number", value: true, quote: text, turnIndex: i, confidence: 0.7 });
    }
    if (DNC_RE.test(text)) {
      const acknowledged = agentSays(i).some((a) => /won'?t call again/i.test(a.text));
      add({ kind: "do_not_call", value: true, quote: text, turnIndex: i, confidence: acknowledged ? 0.95 : 0.9 });
    }
    if (VOICEMAIL_RE.test(text)) add({ kind: "voicemail", value: true, quote: text, turnIndex: i, confidence: 0.85 });
    if (AI_Q_RE.test(text)) add({ kind: "asked_if_ai", value: true, quote: text, turnIndex: i, confidence: 0.95 });
  });

  const result: MineResult = { findings, friction: friction(turns), claude: { used: false } };

  const client = options.anthropic === undefined ? anthropicFromEnv() : options.anthropic;
  if (client) {
    const extra = await mineWithClaude(turns, client);
    result.claude = { used: true, ...(extra.error ? { error: extra.error } : {}) };
    const have = new Set(findings.map((f) => `${f.kind}:${String(f.value)}`));
    const haveKinds = new Set(findings.map((f) => f.kind));
    for (const f of extra.findings) {
      // Claude fills gaps; it does not add a second opinion on a kind the patterns already settled.
      if (haveKinds.has(f.kind) || have.has(`${f.kind}:${String(f.value)}`)) continue;
      if (f.kind === "text_number" && typeof f.value === "string" && f.value !== "this_line") f.value = maskNumber(f.value);
      findings.push(f);
    }
  }
  findings.sort((a, b) => a.turnIndex - b.turnIndex);
  return result;
}
