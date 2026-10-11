/**
 * Starts a cloudflared quick tunnel to the local server and resolves its public HTTPS URL.
 * The hostname changes on every start, so `pnpm live` re-registers the Context MCP and the
 * webhook each time. Dial calls our server through this URL.
 */
import { spawn } from "node:child_process";

export interface Tunnel {
  url: string;
  stop: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startQuickTunnel(port: number, metricsPort = 20299, options: { waitForHealth?: boolean } = {}): Promise<Tunnel> {
  const child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${metricsPort}`, "--url", `http://127.0.0.1:${port}`],
    { stdio: "ignore" },
  );
  const stop = () => {
    child.kill("SIGTERM");
  };
  child.on("error", (error) => console.error(`cloudflared failed to start: ${error.message}`));
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const res = await fetch(`http://127.0.0.1:${metricsPort}/quicktunnel`).catch(() => null);
    const host = res?.ok ? ((await res.json()) as { hostname?: string }).hostname : undefined;
    if (!host) continue;
    const url = `https://${host}`;
    if (options.waitForHealth === false) return { url, stop };
    // DNS for a fresh quick tunnel takes a few seconds to resolve.
    for (let j = 0; j < 40; j++) {
      if ((await fetch(`${url}/health`).catch(() => null))?.ok) return { url, stop };
      await sleep(1000);
    }
  }
  stop();
  throw new Error("The cloudflared quick tunnel did not come up within 70 seconds");
}

/** Waits until the public URL serves /health (fresh quick-tunnel DNS takes a few seconds). */
export async function waitForPublicHealth(url: string, seconds = 60): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    if ((await fetch(`${url}/health`).catch(() => null))?.ok) return;
    await sleep(1000);
  }
  throw new Error(`${url}/health did not answer within ${seconds} seconds`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8787);
  const tunnel = await startQuickTunnel(port);
  console.log(tunnel.url);
  process.on("SIGINT", () => {
    tunnel.stop();
    process.exit(0);
  });
}
