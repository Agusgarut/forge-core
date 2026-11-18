// The REST v3 API under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (app.ts sets it); errors are {message}.
// A repository belongs to the login the token names (scenario.VIEWER); the
// same name under another owner is 404, never 403.

import type { IncomingHttpHeaders } from 'node:http';
import { VIEWER } from './scenario.ts';
import { isOid } from './gitobj.ts';
import {
  committerTime,
  type Comment,
  type ForgeStore,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface ReqCtx {
  readonly method: string;
  /** Decoded path segments (no leading empty segment). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  /** The raw request body (empty when none was sent). */
  readonly body: Buffer;
  /** The parsed JSON body, when the body parsed; undefined otherwise. */
  readonly json: unknown;
  /** True when a non-empty body failed to parse as JSON. */
  readonly jsonError: boolean;
  /** The request's origin (scheme + host), for absolute Link URLs. */
  readonly origin: string;
}

export interface Resp {
  readonly status: number;
  /** JSON value, or a Buffer when `raw` is true. */
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** When true, `body` is a Buffer sent as-is with `contentType`. */
  readonly raw?: boolean;
  readonly contentType?: string;
}

/** A JSON error body, GitHub's shape. */
export function err(status: number, message: string): Resp {
  return { status, body: { message } };
}

export const notFound = (what = 'Not Found'): Resp => err(404, what);
export const badCredentials: Resp = err(401, 'Bad credentials');

/** The request's parsed JSON body as an object, or {} when there is none. */
function bodyObj(ctx: ReqCtx): Record<string, unknown> {
  if (ctx.json !== undefined && typeof ctx.json === 'object' && ctx.json !== null && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse a positive integer query parameter, with a fallback. */
function queryInt(ctx: ReqCtx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Paginate `items` by ?page=&per_page= (default 30, max 100) and build the
 * GitHub Link header from the request's own origin.
 */
function paginate<T>(ctx: ReqCtx, path: string, items: readonly T[]): { page: T[]; link: string } {
  const perPage = Math.min(100, queryInt(ctx, 'per_page', 30));
  const pageNum = queryInt(ctx, 'page', 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const page = items.slice((pageNum - 1) * perPage, pageNum * perPage);
  const base = `${ctx.origin}/api/v3${path}`;
  const links: string[] = [];
  const urlFor = (pageNo: number): string => `${base}?per_page=${perPage}&page=${pageNo}`;
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page, link: links.join(', ') };
}

// ---------------------------------------------------------------- shapes

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@example.invalid`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.userLogin, VIEWER.id),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '', default: false };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

export function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.userLogin, VIEWER.id),
    labels: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner, VIEWER.id),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: pull.merged ? true : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
  };
}

function commentJson(comment: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.userLogin, VIEWER.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

function commitJson(store: ForgeStore, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = store.getObject(repo, oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const view = parseCommitView(obj.data);
  const authorDate = new Date(committerTime(view.committer) * 1000).toISOString();
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: { name: view.authorName, email: view.authorEmail, date: authorDate },
      committer: { name: view.committerName, email: view.committerEmail, date: authorDate },
      message: view.message.replace(/\n+$/, ''),
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    author: userJson(VIEWER.login, VIEWER.id),
    committer: userJson(VIEWER.login, VIEWER.id),
    parents: view.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committer: string;
  readonly message: string;
}

function parseCommitView(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const splitIdent = (value: string): { name: string; email: string } => {
    const match = /^(.*) <([^>]*)>/.exec(value);
    return match === null ? { name: value, email: '' } : { name: match[1] as string, email: match[2] as string };
  };
  const authorParts = splitIdent(author);
  const committerParts = splitIdent(committer);
  return {
    tree,
    parents,
    authorName: authorParts.name,
    authorEmail: authorParts.email,
    committerName: committerParts.name,
    committerEmail: committerParts.email,
    committer,
    message,
  };
}

// ---------------------------------------------------------------- routing

/** A repository the token's viewer owns, or the 404 to answer instead. */
function ownedRepo(store: ForgeStore, owner: string, name: string): Repo | Resp {
  if (owner !== VIEWER.login) return notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function isRepo(value: Repo | Resp): value is Repo {
  return (value as Repo).issues !== undefined;
}

function plainBranch(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Dispatch one /api/v3 request. `segments` excludes the leading `api/v3`. */
export function handleRest(store: ForgeStore, ctx: ReqCtx): Resp {
  const seg = ctx.segments;
  const method = ctx.method;

  if (ctx.jsonError && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    return err(400, 'Problems parsing JSON');
  }

  // GET /api/v3/ — the API root (app.ts also answers it; this is the same).
  if (seg.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    return { status: 200, body: userJson(VIEWER.login, VIEWER.id) };
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, link } = paginate(ctx, '/user/repos', repos.map((repo) => repoJson(repo)));
      return { status: 200, body: page, headers: { link } };
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const name = str(body.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return err(422, 'Validation Failed: name is invalid');
      }
      if (store.getRepo(VIEWER.login, name) !== undefined) {
        return err(422, 'Repository creation failed: name already exists on this account');
      }
      const repo = store.createRepo(name, str(body.description), bool(body.private, false));
      return { status: 201, body: repoJson(repo) };
    }
  }

  // /api/v3/repos/:owner/:name[/...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const rest = seg.slice(3);
    const found = ownedRepo(store, owner, name);
    if (!isRepo(found)) return found;
    const repo = found;

    // GET/PATCH/DELETE /repos/:owner/:name
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(repo) };
      if (method === 'PATCH') {
        const body = bodyObj(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updatedAt = store.nowIso();
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return notFound();
    }

    // Branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches: Array<Record<string, unknown>> = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) branches.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
        }
        return { status: 200, body: branches };
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = store.resolveRef(repo, rest[1] as string);
        if (sha === undefined) return notFound('Branch not found');
        return { status: 200, body: branchJson(repo, rest[1] as string, sha) };
      }
      return notFound();
    }

    // git refs: POST /git/refs, GET /git/refs/heads/:branch
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const body = bodyObj(ctx);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          return err(422, 'Validation Failed: ref must start with refs/heads/ or refs/tags/');
        }
        if (!isOid(sha)) return err(422, 'Validation Failed: sha is not a valid object id');
        const obj = store.getObject(repo, sha);
        if (obj === undefined || obj.type !== 'commit') return err(422, 'Validation Failed: sha is not a commit');
        if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
        repo.refs.set(ref, sha);
        return {
          status: 201,
          body: { ref, node_id: `R_${sha}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } },
        };
      }
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[3] as string}`);
        if (sha === undefined) return notFound('Not Found');
        const ref = `refs/heads/${rest[3] as string}`;
        return {
          status: 200,
          body: { ref, node_id: `R_${sha}`, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } },
        };
      }
      return notFound();
    }

    // Commits
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const refName = ctx.query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, refName);
        if (tip === undefined) return { status: 200, body: [] };
        const commits = store.walkCommits(repo, tip);
        const bodies = commits
          .map((entry) => commitJson(store, repo, entry.oid))
          .filter((entry): entry is Record<string, unknown> => entry !== null);
        const { page, link } = paginate(ctx, `/repos/${owner}/${name}/commits`, bodies);
        return { status: 200, body: page, headers: { link } };
      }
      if (rest.length === 2 && method === 'GET') {
        const body = commitJson(store, repo, rest[1] as string);
        if (body === null) return notFound('Not Found');
        return { status: 200, body };
      }
      return notFound();
    }

    // Contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refName = ctx.query.get('ref') ?? bodyObj(ctx).branch as string | undefined ?? repo.defaultBranch;
      if (method === 'GET') {
        return contentsGet(store, repo, owner, name, path, refName);
      }
      if (method === 'PUT') {
        const body = bodyObj(ctx);
        const message = str(body.message, `Update ${path}`);
        const contentB64 = str(body.content);
        if (contentB64 === '') return err(422, 'Validation Failed: content is required');
        const content = Buffer.from(contentB64, 'base64');
        const branch = plainBranch(refName);
        const existing = store.fileAt(repo, branch, path);
        const creating = existing === undefined;
        if (!creating && typeof body.sha === 'string' && body.sha !== existing.oid) {
          return err(409, 'Conflict: sha does not match the current file');
        }
        if (!creating && body.sha === undefined) {
          return err(409, 'Conflict: sha is required to update a file');
        }
        const { blobOid, commitOid } = store.writeFile(repo, branch, path, content, message);
        return {
          status: creating ? 201 : 200,
          body: {
            content: {
              name: path.split('/').pop(),
              path,
              sha: blobOid,
              size: content.length,
              url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
              html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
              git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
              download_url: null,
              type: 'file',
              encoding: 'base64',
              content: content.toString('base64'),
            },
            commit: { sha: commitOid, message },
          },
        };
      }
      if (method === 'DELETE') {
        const body = bodyObj(ctx);
        const branch = plainBranch(refName);
        const existing = store.fileAt(repo, branch, path);
        if (existing === undefined) return notFound('Not Found');
        if (typeof body.sha === 'string' && body.sha !== existing.oid) {
          return err(409, 'Conflict: sha does not match the current file');
        }
        const commitOid = store.deleteFile(repo, branch, path, str(body.message, `Delete ${path}`));
        if (commitOid === null) return notFound('Not Found');
        return { status: 200, body: { commit: { sha: commitOid } } };
      }
      return notFound();
    }

    // Labels
    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description, default: true })) };
      }
      if (method === 'POST') {
        const body = bodyObj(ctx);
        const labelName = str(body.name);
        if (labelName === '') return err(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) {
          return { status: 201, body: { name: existing.name, color: existing.color, description: existing.description, default: false } };
        }
        const label = { name: labelName, color: str(body.color, 'ededed'), description: str(body.description) };
        repo.labels.set(labelName, label);
        return { status: 201, body: { name: label.name, color: label.color, description: label.description, default: false } };
      }
      return notFound();
    }

    // Issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          if (sort === 'created' || sort === 'updated') {
            list.sort((a, b) => {
              const ta = sort === 'created' ? a.createdAt : a.updatedAt;
              const tb = sort === 'created' ? b.createdAt : b.updatedAt;
              const byTime = ta < tb ? -1 : ta > tb ? 1 : 0;
              const byNumber = a.number - b.number;
              const cmp = byTime !== 0 ? byTime : byNumber;
              return direction === 'asc' ? cmp : -cmp;
            });
          }
          const { page, link } = paginate(ctx, `/repos/${owner}/${name}/issues`, list.map((issue) => issueJson(issue, repo)));
          return { status: 200, body: page, headers: { link } };
        }
        if (method === 'POST') {
          const body = bodyObj(ctx);
          const title = str(body.title);
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
          }
          const issue = store.createIssue(repo, title, str(body.body), labels);
          return { status: 201, body: issueJson(issue, repo) };
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isSafeInteger(number) || number < 1) return notFound('Not Found');
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: issueJson(issue, repo) };
        if (method === 'PATCH') {
          const body = bodyObj(ctx);
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const labels = (body.labels as unknown[]).filter((l): l is string => typeof l === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
            }
            issue.labels = labels;
          }
          issue.updatedAt = store.nowIso();
          return { status: 200, body: issueJson(issue, repo) };
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return { status: 200, body: issue.comments.map((comment) => commentJson(comment, repo, issue.number)) };
        }
        if (method === 'POST') {
          const body = bodyObj(ctx);
          const comment = store.createComment(issue, str(body.body));
          return { status: 201, body: commentJson(comment, repo, issue.number) };
        }
        return notFound();
      }
      return notFound();
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(ctx, `/repos/${owner}/${name}/pulls`, list.map((pull) => pullJson(pull, repo)));
          return { status: 200, body: page, headers: { link } };
        }
        if (method === 'POST') {
          const body = bodyObj(ctx);
          const head = plainBranch(str(body.head));
          const base = plainBranch(str(body.base, repo.defaultBranch));
          const title = str(body.title);
          if (head === '' || base === '') return err(422, 'Validation Failed: head and base are required');
          if (store.resolveRef(repo, head) === undefined) return err(422, `Validation Failed: head branch "${head}" does not exist`);
          if (store.resolveRef(repo, base) === undefined) return err(422, `Validation Failed: base branch "${base}" does not exist`);
          const pull = store.createPull(repo, title, str(body.body), head, base);
          if (pull === null) return err(422, 'Validation Failed: could not create the pull request');
          return { status: 201, body: pullJson(pull, repo) };
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isSafeInteger(number) || number < 1) return notFound('Not Found');
      const pull = repo.pullByNumber.get(number);
      if (pull === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, body: pullJson(pull, repo) };
        if (method === 'PATCH') {
          const body = bodyObj(ctx);
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          if (body.state === 'closed') pull.state = 'closed';
          pull.updatedAt = store.nowIso();
          return { status: 200, body: pullJson(pull, repo) };
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = store.pullFiles(repo, pull);
        return { status: 200, body: files };
      }
      if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
        const headCommits = store.walkCommits(repo, pull.headSha);
        const baseSet = new Set(store.walkCommits(repo, pull.baseSha).map((entry) => entry.oid));
        const bodies = headCommits
          .filter((entry) => !baseSet.has(entry.oid))
          .map((entry) => commitJson(store, repo, entry.oid))
          .filter((entry): entry is Record<string, unknown> => entry !== null);
        return { status: 200, body: bodies };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged) {
          return { status: 200, body: { sha: pull.mergeCommitSha, merged: true, message: 'Pull request successfully merged' } };
        }
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const sha = store.mergePull(repo, pull);
        if (sha === null) return err(405, 'Merge conflict: this pull request cannot be merged');
        return { status: 200, body: { sha, merged: true, message: 'Pull request successfully merged' } };
      }
      return notFound();
    }
  }

  return notFound();
}

/** GET /repos/:owner/:name/contents/:path — a file or a directory listing. */
function contentsGet(
  store: ForgeStore,
  repo: Repo,
  owner: string,
  name: string,
  path: string,
  refName: string,
): Resp {
  const branch = plainBranch(refName);
  const tip = store.resolveRef(repo, branch);
  if (tip === undefined) return notFound('Not Found');
  if (path === '') {
    const entries = store.dirAt(repo, branch, '');
    if (entries === undefined) return notFound('Not Found');
    return { status: 200, body: entries.map((entry) => contentEntryJson(repo, owner, name, '', entry, branch)) };
  }
  const file = store.fileAt(repo, branch, path);
  if (file !== undefined) {
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: path.split('/').pop(),
        path,
        content: file.data.toString('base64'),
        sha: file.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `https://github.com/${owner}/${name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
        download_url: null,
      },
    };
  }
  const entries = store.dirAt(repo, branch, path);
  if (entries === undefined) return notFound('Not Found');
  return { status: 200, body: entries.map((entry) => contentEntryJson(repo, owner, name, path, entry, branch)) };
}

function contentEntryJson(
  repo: Repo,
  owner: string,
  name: string,
  dir: string,
  entry: { mode: string; name: string; oid: string },
  branch: string,
): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
    html_url: `https://github.com/${owner}/${name}/${isDir ? 'tree' : 'blob'}/${branch}/${path}`,
    git_url: `/api/v3/repos/${owner}/${name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`,
  };
}
