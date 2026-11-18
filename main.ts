// forge-core entrypoint: the lifecycle between this process and the make.fun
// env. The env is the only remote this process talks to; everything the
// trial scores — git smart HTTP, REST v3, GraphQL, MCP — lives in app.ts.
//
// The run, in order:
//   1. MAKEFUN_ENV_URL must name the env's origin (http://store:8080 in a
//      trial). Without it there is nothing to register with, so exit 1.
//   2. Listen on an ephemeral port. Never 8080: that port belongs to the env.
//   3. POST /register {"port": N} so the env knows where to dial this forge.
//      200 registers; 409 means a first register already won and this
//      process just waits like any other. 400/405 are contract errors and
//      end the run; anything else is retried, the env may still be starting.
//   4. GET /done until it answers {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll, not a
//      held-open request. Never exit before the env says done.
//   5. Close the server and exit 0. The harness stops the env afterwards and
//      the env's export is what the scorer reads.
//
// Progress is reported as one JSON object per line on stderr, so a harness
// can follow the run without parsing prose. A SIGTERM or SIGINT closes the
// server and exits 0 instead of being killed mid-request.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** Env origin, without a trailing slash. Empty when unset. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const LIMITS = {
  /** One register or done request may take this long before it is abandoned. */
  requestMs: 30_000,
  /** First wait between retries, and the longest wait. */
  backoffBaseMs: 250,
  backoffMaxMs: 2_000,
  /** How long a closing server gets before the process exits anyway. */
  closeGraceMs: 1_500,
} as const;

/** The server this process owns, once bound; the signal handler closes it. */
let server: Server | null = null;

/** One structured progress line on stderr: {"ts","event",...fields}. */
function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait after the `attempt`-th failed request: exponential from
 * backoffBaseMs up to backoffMaxMs, multiplied by a jitter factor in
 * [0.5, 1) so two restarting entries do not retry in lockstep.
 */
function backoffMs(attempt: number): number {
  const plain = Math.min(LIMITS.backoffMaxMs, LIMITS.backoffBaseMs * 2 ** Math.min(attempt, 8));
  return Math.floor(plain * (0.5 + Math.random() * 0.5));
}

/** Close the server on SIGTERM/SIGINT and exit 0; never die mid-request. */
function installShutdown(): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutdown', { signal });
    if (server === null) {
      process.exit(0);
      return;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), LIMITS.closeGraceMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Build the app and bind an ephemeral port; returns the bound port. */
async function bind(): Promise<number> {
  server = createApp();
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  log('bound', { port: address.port });
  return address.port;
}

/**
 * Register the bound port until the env accepts it. A 400 or 405 is a
 * contract error and throws; a network error or any other status is retried
 * with jittered backoff.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number | null = null;
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(LIMITS.requestMs),
      });
      status = res.status;
      if (status === 200 || status === 409) {
        log('registered', { port, attempts: attempt + 1, status });
        return;
      }
      if (status === 400 || status === 405) {
        throw new Error(`register rejected with HTTP ${status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
    }
    log('register-retry', { attempt: attempt + 1, status });
    await sleep(backoffMs(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return earlier. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(LIMITS.requestMs) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) {
          log('done', { polls: attempt + 1 });
          return;
        }
      }
    } catch {
      // The env is not answering, or the poll timed out: it is not done.
    }
    await sleep(backoffMs(attempt));
  }
}

/** The whole life of the process: bind, register, wait for done. */
async function main(): Promise<void> {
  installShutdown();
  const port = await bind();
  await register(port);
  await waitForDone();
  server!.close();
  log('closed', { port });
}

if (ENV_URL === '') {
  log('no-env', {});
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  log('failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
