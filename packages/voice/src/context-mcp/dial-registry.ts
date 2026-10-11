import { MIN_SECRET_BYTES, MIN_TOKEN_BYTES, maskSecret, secretProblem } from "./secret";
import { contextMcpUrl } from "./routes";

/**
 * Registers the Context MCP with Dial (docs.getdial.ai/openapi.json, checked 2026-10-11):
 *
 *   GET    /api/v1/context-mcps       -> { contextMcps: ContextMcp[] }
 *   POST   /api/v1/context-mcps       {name, url, headers?, queryParams?, timeoutMs?} -> 201 { contextMcp, authorizationUrl? }
 *   GET    /api/v1/context-mcps/{id}  -> { contextMcp }
 *   DELETE /api/v1/context-mcps/{id}  -> 204
 *
 * There is no PATCH and no refresh: Dial snapshots tools/list when the connection
 * is created. Registration is therefore idempotent by replacement. It deletes every
 * connection with our name, then creates one. Dial probes the URL on POST, so the
 * server and tunnel must be up, otherwise Dial answers 400.
 *
 * This only registers a URL. It never places a call or sends a message.
 */
export const DIAL_API_BASE = "https://api.getdial.ai/api/v1";
export const CONTEXT_MCP_NAME = "platypus";
export const CONTEXT_MCP_TIMEOUT_MS = 10_000;

export interface DialContextMcp {
  id: string;
  name: string;
  url: string;
  authMode: "none" | "static" | "oauth";
  status: "pending_auth" | "connected" | "error";
  toolCount: number;
  timeoutMs: number | null;
  headersMasked?: Record<string, string>;
  lastError: string | null;
  createdAt: string;
}

export interface RegistryEnv {
  DIAL_API_KEY?: string | undefined;
  PUBLIC_BASE_URL?: string | undefined;
  CONTEXT_MCP_SECRET?: string | undefined;
  CONTEXT_MCP_TOKEN?: string | undefined;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DialApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DialApiError";
  }
}

/** Replaces every credential in a string with its mask, so nothing printed leaks one. */
export function makeRedactor(...secrets: (string | undefined)[]): (text: string) => string {
  const known = secrets.filter((s): s is string => Boolean(s && s.length >= 8));
  return (text) => known.reduce((out, s) => out.split(s).join(maskSecret(s)), text);
}

interface Client {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

function dialClient(apiKey: string, fetchImpl: FetchLike, redact: (s: string) => string): Client {
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetchImpl(`${DIAL_API_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new DialApiError(res.status, redact(`Dial ${method} ${path} answered ${res.status}: ${text.slice(0, 500)}`));
      return (text ? JSON.parse(text) : {}) as T;
    },
  };
}

export interface RegistrationPlan {
  name: string;
  url: string;
  token: string;
  timeoutMs: number;
}

/** Validates the environment for registration. Throws one clear message listing every problem. */
export function planRegistration(env: RegistryEnv): RegistrationPlan {
  const problems: string[] = [];
  const base = env.PUBLIC_BASE_URL?.trim();
  if (!base) problems.push("PUBLIC_BASE_URL is missing (the public https origin of pnpm dev, e.g. your cloudflared tunnel)");
  else {
    let url: URL | undefined;
    try {
      url = new URL(base);
    } catch {
      problems.push("PUBLIC_BASE_URL is not a URL");
    }
    if (url && url.protocol !== "https:") problems.push("PUBLIC_BASE_URL must be https: Dial only connects to https Context MCP servers");
  }
  const secretIssue = secretProblem(env.CONTEXT_MCP_SECRET?.trim(), MIN_SECRET_BYTES);
  if (secretIssue) problems.push(`CONTEXT_MCP_SECRET ${secretIssue}`);
  const tokenIssue = secretProblem(env.CONTEXT_MCP_TOKEN?.trim(), MIN_TOKEN_BYTES);
  if (tokenIssue) problems.push(`CONTEXT_MCP_TOKEN ${tokenIssue}`);
  if (problems.length) throw new Error(`Cannot register the Context MCP:\n- ${problems.join("\n- ")}`);
  return {
    name: CONTEXT_MCP_NAME,
    url: contextMcpUrl(base!, env.CONTEXT_MCP_SECRET!.trim()),
    token: env.CONTEXT_MCP_TOKEN!.trim(),
    timeoutMs: CONTEXT_MCP_TIMEOUT_MS,
  };
}

export function registrationBody(plan: RegistrationPlan) {
  return { name: plan.name, url: plan.url, headers: { Authorization: `Bearer ${plan.token}` }, timeoutMs: plan.timeoutMs };
}

export interface RegisterResult {
  deleted: string[];
  contextMcp: DialContextMcp;
  authorizationUrl: string | null;
}

export async function registerContextMcp(apiKey: string, plan: RegistrationPlan, fetchImpl: FetchLike, redact: (s: string) => string): Promise<RegisterResult> {
  const dial = dialClient(apiKey, fetchImpl, redact);
  const { contextMcps = [] } = await dial.request<{ contextMcps?: DialContextMcp[] }>("GET", "/context-mcps");
  const deleted: string[] = [];
  for (const existing of contextMcps.filter((m) => m.name === plan.name)) {
    try {
      await dial.request("DELETE", `/context-mcps/${encodeURIComponent(existing.id)}`);
    } catch (error) {
      // Already gone is fine; anything else stops us before creating a duplicate.
      if (!(error instanceof DialApiError && error.status === 404)) throw error;
    }
    deleted.push(existing.id);
  }
  const created = await dial.request<{ contextMcp: DialContextMcp; authorizationUrl?: string | null }>("POST", "/context-mcps", registrationBody(plan));
  return { deleted, contextMcp: created.contextMcp, authorizationUrl: created.authorizationUrl ?? null };
}

export async function listContextMcps(apiKey: string, name: string, fetchImpl: FetchLike, redact: (s: string) => string): Promise<DialContextMcp[]> {
  const dial = dialClient(apiKey, fetchImpl, redact);
  const { contextMcps = [] } = await dial.request<{ contextMcps?: DialContextMcp[] }>("GET", "/context-mcps");
  return contextMcps.filter((m) => m.name === name);
}

export function describeContextMcp(m: DialContextMcp, redact: (s: string) => string): string {
  return redact(
    [
      `id         ${m.id}`,
      `name       ${m.name}`,
      `url        ${m.url}`,
      `status     ${m.status}`,
      `authMode   ${m.authMode}`,
      `toolCount  ${m.toolCount}`,
      `timeoutMs  ${m.timeoutMs ?? "default (120000)"}`,
      `lastError  ${m.lastError ?? "none"}`,
    ].join("\n"),
  );
}

/** Problems worth a non-zero exit: anything but a static, connected server exposing all five tools. */
export function healthProblems(m: DialContextMcp, expectedTools: number): string[] {
  const out: string[] = [];
  if (m.status !== "connected") out.push(`status is ${m.status}, expected connected`);
  if (m.authMode !== "static") out.push(`authMode is ${m.authMode}, expected static (did the server answer 401?)`);
  if (m.toolCount !== expectedTools) out.push(`toolCount is ${m.toolCount}, expected ${expectedTools}`);
  return out;
}

// ---- CLIs (packages/voice/scripts/*.ts are thin wrappers) ----------------------

export interface CliIo {
  env: RegistryEnv;
  fetch: FetchLike;
  out: (line: string) => void;
}

const EXPECTED_TOOLS = 5;

/** `pnpm dial:register-mcp [--dry-run]`. Returns the process exit code. */
export async function runRegisterCli(argv: string[], io: CliIo): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const apiKey = io.env.DIAL_API_KEY?.trim();
  const redact = makeRedactor(io.env.CONTEXT_MCP_SECRET?.trim(), io.env.CONTEXT_MCP_TOKEN?.trim(), apiKey);
  let plan: RegistrationPlan;
  try {
    plan = planRegistration(io.env);
  } catch (error) {
    io.out((error as Error).message);
    return 2;
  }
  if (dryRun) {
    io.out("Dry run: nothing is sent.");
    io.out(`GET    ${DIAL_API_BASE}/context-mcps`);
    io.out(`DELETE ${DIAL_API_BASE}/context-mcps/{id}   for each connection named "${plan.name}"`);
    io.out(`POST   ${DIAL_API_BASE}/context-mcps`);
    io.out(redact(JSON.stringify(registrationBody(plan), null, 2)));
    io.out(`Authorization: Bearer ${apiKey ? maskSecret(apiKey) : "(DIAL_API_KEY unset)"}`);
    return 0;
  }
  if (!apiKey) {
    io.out("DIAL_API_KEY is not set. Put your Dial key in .env (never commit it), or use --dry-run to preview the request.");
    return 2;
  }
  try {
    const result = await registerContextMcp(apiKey, plan, io.fetch, redact);
    if (result.deleted.length) io.out(`Replaced ${result.deleted.length} earlier "${plan.name}" connection(s): ${result.deleted.join(", ")}`);
    io.out(describeContextMcp(result.contextMcp, redact));
    if (result.authorizationUrl) io.out("Dial asked for OAuth consent: the server must have answered 401. It should answer 403 for a bad token.");
    const problems = healthProblems(result.contextMcp, EXPECTED_TOOLS);
    for (const p of problems) io.out(`Problem: ${p}`);
    return problems.length ? 1 : 0;
  } catch (error) {
    io.out(redact((error as Error).message));
    if (error instanceof DialApiError && error.status === 400) io.out("Dial probes the URL on registration: is pnpm dev running and the tunnel up?");
    return 1;
  }
}

/** `pnpm dial:mcp-status`. Returns the process exit code. */
export async function runStatusCli(_argv: string[], io: CliIo): Promise<number> {
  const apiKey = io.env.DIAL_API_KEY?.trim();
  if (!apiKey) {
    io.out("DIAL_API_KEY is not set. Put your Dial key in .env (never commit it).");
    return 2;
  }
  const redact = makeRedactor(io.env.CONTEXT_MCP_SECRET?.trim(), io.env.CONTEXT_MCP_TOKEN?.trim(), apiKey);
  try {
    const found = await listContextMcps(apiKey, CONTEXT_MCP_NAME, io.fetch, redact);
    if (found.length === 0) {
      io.out(`No Context MCP named "${CONTEXT_MCP_NAME}" is registered. Run pnpm dial:register-mcp.`);
      return 1;
    }
    if (found.length > 1) io.out(`Warning: ${found.length} connections named "${CONTEXT_MCP_NAME}"; pnpm dial:register-mcp replaces them with one.`);
    let code = 0;
    for (const m of found) {
      io.out(describeContextMcp(m, redact));
      const problems = healthProblems(m, EXPECTED_TOOLS);
      for (const p of problems) io.out(`Problem: ${p}`);
      if (problems.length) code = 1;
    }
    return code;
  } catch (error) {
    io.out(redact((error as Error).message));
    return 1;
  }
}
