// MCP at POST /mcp: JSON-RPC 2.0 Streamable HTTP, answered as plain JSON
// (never SSE) in under 3 seconds. Two handshakes are supported:
//   - modern (2026-07-28): `server/discover` answers supportedVersions, a
//     capabilities.tools object and serverInfo, the latter also under
//     result._meta["io.modelcontextprotocol/serverInfo"].
//   - legacy (<= 2025-11-25): `initialize` + `notifications/initialized`
//     (a notification, answered with HTTP 202 and an empty body).
// tools/list is a module-level constant, so two calls are byte-identical.
// tools/call maps argument names to the nearest schema property (synonyms
// included) and works on the same store as REST, so ids never change.
// No Mcp-Session-Id header is ever emitted; DELETE /mcp answers 204.

import { VIEWER } from './scenario.ts';
import { issueJson, pullJson, repoJson, type ReqCtx, type Resp } from './rest.ts';
import { type ForgeStore, type Repo } from './store.ts';

const SERVER_NAME = 'forge-core';
const SERVER_VERSION = '1.0.0';

// The revisions this server speaks, newest first.
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
// Revisions the legacy `initialize` handshake accepts.
const LEGACY_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

// Built once: two tools/list calls serialize the identical bytes.
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        owner: { type: 'string', description: 'The owner of the repository (defaults to the viewer).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Canonical tool names plus the aliases the client recognises, normalised
// (lowercase, non-alphanumerics stripped) so a server prefix still matches.
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  createrepo: 'create_repo',
  createrepository: 'create_repo',
  getrepo: 'get_repo',
  getrepository: 'get_repo',
  createissue: 'create_issue',
  issuecreate: 'create_issue',
  listissues: 'list_issues',
  listissue: 'list_issues',
  createpullrequest: 'create_pull_request',
  createpr: 'create_pull_request',
  mergepullrequest: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTool(name: string): string | null {
  const normalized = normalizeToolName(name);
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (normalized === alias || normalized.endsWith(alias)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------- arguments

type Args = Record<string, unknown>;

function pickString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Args, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Split owner/repo out of the args, honouring `full_name` as a fallback. */
function resolveOwnerRepo(args: Args): { owner: string; repo: string } {
  let owner = pickString(args, 'owner', 'login');
  let repo = pickString(args, 'repo', 'repository');
  const fullName = pickString(args, 'full_name', 'fullName');
  if ((owner === undefined || repo === undefined) && fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner ??= fullName.slice(0, slash);
      repo ??= fullName.slice(slash + 1);
    }
  }
  return { owner: owner ?? '', repo: repo ?? '' };
}

function findRepo(store: ForgeStore, owner: string, repoName: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return store.getRepo(owner, repoName);
}

// ---------------------------------------------------------------- results

function toolOk(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: ForgeStore, name: string, args: Args): Record<string, unknown> {
  const tool = resolveTool(name);
  if (tool === null) {
    // Unknown tools are reported through the JSON-RPC error below, not here.
    throw new Error(`__unknown_tool__:${name}`);
  }
  switch (tool) {
    case 'create_repo': {
      const repoName = pickString(args, 'name', 'repo');
      if (repoName === undefined) return toolError('create_repo requires a name.');
      const owner = pickString(args, 'owner') ?? VIEWER.login;
      const description = pickString(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const created = store.createRepo(owner, repoName, description, isPrivate);
      if (created === null) return toolError(`Repository ${owner}/${repoName} already exists.`);
      return toolOk(repoJson(created));
    }
    case 'get_repo': {
      const { owner, repo } = resolveOwnerRepo(args);
      const found = findRepo(store, owner, repo);
      if (found === undefined) return toolError(`Repository ${owner}/${repo} not found.`);
      return toolOk(repoJson(found));
    }
    case 'create_issue': {
      const { owner, repo } = resolveOwnerRepo(args);
      const found = findRepo(store, owner, repo);
      if (found === undefined) return toolError(`Repository ${owner}/${repo} not found.`);
      const title = pickString(args, 'title');
      if (title === undefined) return toolError('create_issue requires a title.');
      const body = pickString(args, 'body') ?? '';
      const issue = store.createIssue(found, title, body, []);
      return toolOk(issueJson(issue, found));
    }
    case 'list_issues': {
      const { owner, repo } = resolveOwnerRepo(args);
      const found = findRepo(store, owner, repo);
      if (found === undefined) return toolError(`Repository ${owner}/${repo} not found.`);
      const state = pickString(args, 'state') ?? 'open';
      const list = found.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolOk(list.map((issue) => issueJson(issue, found)));
    }
    case 'create_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const found = findRepo(store, owner, repo);
      if (found === undefined) return toolError(`Repository ${owner}/${repo} not found.`);
      const title = pickString(args, 'title');
      const head = pickString(args, 'head', 'head_ref', 'headRef', 'head_branch');
      const base = pickString(args, 'base', 'base_ref', 'baseRef', 'base_branch');
      if (title === undefined || head === undefined || base === undefined) {
        return toolError('create_pull_request requires title, head and base.');
      }
      const body = pickString(args, 'body') ?? '';
      const pull = store.createPull(found, title, body, head, base);
      if (pull === null) return toolError(`Could not create a pull request from ${head} into ${base}.`);
      return toolOk(pullJson(pull, found));
    }
    case 'merge_pull_request': {
      const { owner, repo } = resolveOwnerRepo(args);
      const found = findRepo(store, owner, repo);
      if (found === undefined) return toolError(`Repository ${owner}/${repo} not found.`);
      const number = pickNumber(args, 'pull_number', 'pullNumber', 'pull_request_number', 'number');
      if (number === undefined) return toolError('merge_pull_request requires a pull_number.');
      const pull = found.pullByNumber.get(number);
      if (pull === undefined) return toolError(`Pull request #${number} not found.`);
      if (pull.merged) {
        return toolOk({ sha: pull.mergeCommitSha ?? '', merged: true, message: 'Pull request already merged.' });
      }
      const sha = store.mergePull(found, pull);
      if (sha === null) return toolError(`Pull request #${number} cannot be merged: it conflicts with the base branch.`);
      return toolOk({ sha, merged: true, message: 'Pull request successfully merged.' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

function handleRequest(store: ForgeStore, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id;
  const hasId = id !== undefined && id !== null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== undefined && typeof request.params === 'object' && request.params !== null
    ? (request.params as Args)
    : {}) as Args;

  // Notifications (no id) are acknowledged with HTTP 202 and no body.
  if (!hasId) return null;

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (!LEGACY_VERSIONS.has(version)) {
        return rpcError(id, -32602, `Unsupported protocol version: ${version || '(none)'}`, { supported: [...SUPPORTED_VERSIONS] });
      }
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== undefined && typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Args)
        : {}) as Args;
      if (resolveTool(name) === null) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        return rpcResult(id, callTool(store, name, args));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('__unknown_tool__:')) {
          return rpcError(id, -32602, `Unknown tool: ${name}`);
        }
        throw error;
      }
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

/** Handle POST /mcp (auth is checked by app.ts before this runs). */
export function handleMcp(store: ForgeStore, ctx: ReqCtx): Resp {
  if (ctx.jsonError) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const parsed = ctx.json;
  if (Array.isArray(parsed)) {
    const results: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        results.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const result = handleRequest(store, entry as RpcRequest);
      if (result !== null) results.push(result);
    }
    return { status: 200, body: results };
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    const result = handleRequest(store, parsed as RpcRequest);
    // A notification gets HTTP 202 with an empty body.
    if (result === null) return { status: 202, body: '' };
    return { status: 200, body: result };
  }
  return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
}
