/**
 * `pnpm ci:hygiene`: repository rules that a linter can't see, enforced on every PR.
 *
 *   1. No committed .env files (only .env.example and friends).
 *   2. No real phone numbers. Every E.164 number in a tracked file must be fictional:
 *      NANP 555-01xx (any area code), the +1 555 area code, or +1 415 555 xxxx.
 *   3. No AI co-author or "Generated with" attribution in the commit messages of the range.
 *   4. No TODO or FIXME left in packages/*\/src.
 *   5. No tracked file over 1 MB.
 *
 * The commit range comes from the first argument or HYGIENE_RANGE ("base..head");
 * locally it defaults to origin/main..HEAD.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_FILE_BYTES = 1024 * 1024;

/** Example env files that are meant to be committed. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Files allowed to contain non-fictional-looking E.164 strings. The lockfile holds
 * base64 integrity hashes, which can contain "+<digits>" by chance. Add a docs path here
 * only when it genuinely needs a real-format example, and say why.
 */
export const PHONE_ALLOWLIST = new Set(["pnpm-lock.yaml"]);

export interface Finding {
  rule: "env-file" | "phone-number" | "ai-attribution" | "todo" | "large-file";
  where: string;
  detail: string;
}

export function isCommittedEnvFile(path: string): boolean {
  const name = basename(path);
  return /^\.env(\..+)?$/.test(name) && !ENV_TEMPLATES.has(name);
}

const E164 = /(?<![\w+])\+[1-9]\d{7,14}(?!\d)/g;

/** True for numbers reserved for fiction or tests; anything else could ring a real person. */
export function isFictionalNumber(e164: string): boolean {
  if (!/^\+1\d{10}$/.test(e164)) return false; // every fixture is NANP; any other country code is suspect
  const area = e164.slice(2, 5);
  const exchange = e164.slice(5, 8);
  const line = e164.slice(8);
  if (area === "555") return true;
  if (area === "415" && exchange === "555") return true;
  return exchange === "555" && line.startsWith("01"); // 555-0100 through 555-0199 are reserved for fiction
}

export function findPhoneNumbers(text: string): { number: string; line: number }[] {
  const out: { number: string; line: number }[] = [];
  text.split("\n").forEach((content, i) => {
    for (const match of content.matchAll(E164)) {
      if (!isFictionalNumber(match[0])) out.push({ number: match[0], line: i + 1 });
    }
  });
  return out;
}

const AI_NAMES = String.raw`claude|anthropic|copilot|chatgpt|openai|gpt-?\d|gemini|cursor|devin|codeium|windsurf|aider|codex`;
const AI_COAUTHOR = new RegExp(String.raw`^\s*co-authored-by:.*\b(${AI_NAMES})\b`, "im");
const GENERATED_WITH = new RegExp(String.raw`(🤖\s*)?generated (with|by)\s*\[?\s*(${AI_NAMES}|ai\b)`, "i");

/** Returns the offending line of a commit message, or null when it carries no AI attribution. */
export function findAttribution(message: string): string | null {
  for (const re of [AI_COAUTHOR, GENERATED_WITH]) {
    const hit = re.exec(message);
    if (hit) return message.split("\n").find((l) => re.test(l))?.trim() ?? hit[0].trim();
  }
  return null;
}

export function findTodos(text: string): number[] {
  return text.split("\n").flatMap((l, i) => (/\b(TODO|FIXME)\b/.test(l) ? [i + 1] : []));
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function resolveRange(): string | null {
  const explicit = process.argv[2] ?? process.env.HYGIENE_RANGE;
  if (explicit) {
    // A push that creates a branch reports an all-zero "before"; check just the pushed commit then.
    const [base, head] = explicit.split("..");
    return base && /^0+$/.test(base) ? `${head ?? "HEAD"}~1..${head ?? "HEAD"}` : explicit;
  }
  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"]);
    return "origin/main..HEAD";
  } catch {
    return null;
  }
}

function commitsIn(range: string): { sha: string; message: string }[] {
  let raw: string;
  try {
    raw = git(["log", "--format=%H%x00%B%x1e", range]);
  } catch {
    // The base can be missing after a force-push; still check the commit being built.
    console.log(`::warning title=hygiene::commit range ${range} is not available; checking HEAD only`);
    raw = git(["log", "-1", "--format=%H%x00%B%x1e", "HEAD"]);
  }
  return raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", message = ""] = chunk.split("\x00");
      return { sha, message };
    });
}

export function scan(): { findings: Finding[]; files: number; commits: number; range: string | null } {
  const findings: Finding[] = [];
  const files = git(["ls-files", "-z"]).split("\0").filter((p) => p && existsSync(p));

  for (const path of files) {
    if (isCommittedEnvFile(path)) findings.push({ rule: "env-file", where: path, detail: "env files hold secrets; commit .env.example instead" });

    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) findings.push({ rule: "large-file", where: path, detail: `${(size / 1024 / 1024).toFixed(2)} MB (limit 1 MB)` });

    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8000).includes(0)) continue; // binary
    const text = buffer.toString("utf8");

    if (!PHONE_ALLOWLIST.has(path)) {
      for (const hit of findPhoneNumbers(text)) {
        findings.push({ rule: "phone-number", where: `${path}:${hit.line}`, detail: `${hit.number.slice(0, 5)}… is not a fictional number (use 555-01xx)` });
      }
    }
    if (/^packages\/[^/]+\/src\//.test(path)) {
      for (const line of findTodos(text)) findings.push({ rule: "todo", where: `${path}:${line}`, detail: "finish it or open an issue" });
    }
  }

  const range = resolveRange();
  const commits = range ? commitsIn(range) : [];
  for (const { sha, message } of commits) {
    const hit = findAttribution(message);
    if (hit) findings.push({ rule: "ai-attribution", where: sha.slice(0, 10), detail: hit });
  }
  return { findings, files: files.length, commits: commits.length, range };
}

function main(): void {
  const { findings, files, commits, range } = scan();
  const lines = [
    "### Repository hygiene",
    "",
    `Scanned ${files} tracked files and ${commits} commit message${commits === 1 ? "" : "s"}${range ? ` in \`${range}\`` : " (no commit range available)"}.`,
    "",
  ];
  if (findings.length === 0) lines.push("All checks passed: no .env files, no real phone numbers, no AI attribution, no TODO/FIXME in src, no file over 1 MB.");
  else {
    lines.push("| Rule | Where | Detail |", "|---|---|---|");
    for (const f of findings) lines.push(`| ${f.rule} | \`${f.where}\` | ${f.detail.replace(/\|/g, "\\|")} |`);
  }
  const markdown = lines.join("\n");
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
  if (findings.length) {
    for (const f of findings) console.log(`::error title=hygiene/${f.rule}::${f.where} ${f.detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
