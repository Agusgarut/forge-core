// The HTTP server: routing, body reading, Bearer auth and the
// X-GitHub-Request-Id header on every reply. main.ts owns the lifecycle
// (listen on an ephemeral port, register, wait for /done); this file owns
// the surface: /healthz, REST v3 under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp and git smart HTTP at /{owner}/{repo}.git.
// Auth: every route except /healthz requires `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>` (the git client sends the same header). Without a
// header, or with the wrong token, the answer is 401 JSON. Unknown routes
// are 404 JSON; a malformed JSON body is 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { badCredentials, err, handleRest, type ReqCtx, type Resp } from './rest.ts';
import { ForgeStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** Packs stay well under this; anything bigger is a client error, not a forge. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function sendResp(res: ServerResponse, resp: Resp, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(resp.headers ?? {}) };
  if (resp.raw === true && Buffer.isBuffer(resp.body)) {
    res.writeHead(resp.status, {
      'content-type': resp.contentType ?? 'application/octet-stream',
      'content-length': resp.body.length,
      ...headers,
    });
    res.end(resp.body);
    return;
  }
  if (resp.body === '' || resp.status === 204) {
    // Notifications (MCP 202) and 204s carry no body at all.
    res.writeHead(resp.status, { 'content-length': 0, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(resp.body)}\n`;
  res.writeHead(resp.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Read the whole request body, or null when it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  // The trial always sets MAKEFUN_SHOP_TOKEN; without it (local runs) any
  // non-empty bearer is accepted, but a missing header still fails.
  if (SHOP_TOKEN !== '' && token !== SHOP_TOKEN) return false;
  return true;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, store: ForgeStore, requestId: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendResp(res, { status: 200, body: { ok: true } }, requestId);
    return;
  }

  if (!authorized(req)) {
    sendResp(res, badCredentials, requestId);
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    sendResp(res, err(413, 'Request Entity Too Large'), requestId);
    return;
  }

  const segments = path.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const contentType = req.headers['content-type'] ?? '';
  const wantsJson = contentType.includes('json') || path.startsWith('/api/') || path === '/mcp';
  let json: unknown;
  let jsonError = false;
  if (wantsJson && body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      jsonError = true;
    }
  }
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const ctx: ReqCtx = { method, segments, query: url.searchParams, headers: req.headers, body, json, jsonError, origin };

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendResp(res, err(404, 'Not Found'), requestId);
      return;
    }
    sendResp(res, handleGraphQL(store, ctx), requestId);
    return;
  }

  // MCP: JSON-RPC 2.0 Streamable HTTP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendResp(res, { status: 204, body: '' }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendResp(res, err(404, 'Not Found'), requestId);
      return;
    }
    sendResp(res, handleMcp(store, ctx), requestId);
    return;
  }

  // REST v3: the handler takes segments relative to /api/v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    sendResp(res, handleRest(store, { ...ctx, segments: segments.slice(2) }), requestId);
    return;
  }

  // Git smart HTTP at /{owner}/{repo}.git/...
  const gitResp = handleGit(store, ctx);
  if (gitResp !== null) {
    sendResp(res, gitResp, requestId);
    return;
  }

  sendResp(res, err(404, 'Not Found'), requestId);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new ForgeStore();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestCounter}`;
    void handle(req, res, store, requestId).catch(() => {
      // A request handler must never take the process down: answer 500 JSON.
      try {
        sendResp(res, err(500, 'Internal Server Error'), requestId);
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  // Keep-alive is what the read workload rides on; the defaults already
  // keep connections open, these just make the intent explicit.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 60000;
  return server;
}
