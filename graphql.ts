// GraphQL v4 at POST /api/graphql: the documents gh and github-mcp-server
// send, answered against the same store as REST. A small hand-written
// parser and executor (no dependency) covering the operation shapes the
// suite sends: queries, mutations, variables, aliases, inline fragments,
// connections (nodes + pageInfo), introspection via __type, batched bodies
// (a JSON array answers a JSON array, in order), and unknown fields as
// HTTP 200 with an errors array naming the field.
//
// Node ids are opaque: base64("<Kind>:<repoId>:<number>..."), stable across
// reads and never equal to a databaseId or a number.

import { VIEWER } from './scenario.ts';
import { type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { type ReqCtx, type Resp, err } from './rest.ts';

// ---------------------------------------------------------------- ids

function encodeId(kind: string, parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

const repoIdOf = (repo: Repo): string => encodeId('Repository', [repo.id]);
const issueIdOf = (repo: Repo, issue: Issue): string => encodeId('Issue', [repo.id, issue.number]);
const pullIdOf = (repo: Repo, pull: Pull): string => encodeId('PullRequest', [repo.id, pull.number]);
const commentIdOf = (repo: Repo, issue: Issue, commentId: number): string =>
  encodeId('IssueComment', [repo.id, issue.number, commentId]);

// ---------------------------------------------------------------- parser

type ValueNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly value: ValueNode }>;
  readonly children: readonly SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { readonly kind: 'inlineFragment'; readonly typeCondition: string | null; readonly children: readonly SelectionNode[] }
  | { readonly kind: 'fragmentSpread'; readonly name: string };

interface VarDef {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: ValueNode | null;
}

interface OperationNode {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly varDefs: readonly VarDef[];
  readonly selections: readonly SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentNode>;
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    this.skipIgnored();
    while (this.pos < this.text.length) {
      if (this.peek() === '{') {
        operations.push(this.parseOperation('query', null, []));
      } else {
        const keyword = this.readName();
        if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
          const name = this.peekIsNameStart() ? this.readName() : null;
          const varDefs = this.peek() === '(' ? this.parseVarDefs() : [];
          operations.push(this.parseOperation(keyword, name, varDefs));
        } else if (keyword === 'fragment') {
          const name = this.readName();
          this.expectWord('on');
          const typeCondition = this.readName();
          const selections = this.parseSelectionSet();
          fragments.set(name, { name, typeCondition, selections });
        } else {
          throw new ParseError(`unexpected ${JSON.stringify(keyword)}`);
        }
      }
      this.skipIgnored();
    }
    return { operations, fragments };
  }

  private parseOperation(kind: 'query' | 'mutation' | 'subscription', name: string | null, varDefs: VarDef[]): OperationNode {
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseVarDefs(): VarDef[] {
    this.expect('(');
    const defs: VarDef[] = [];
    this.skipIgnored();
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.readName();
      this.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      this.skipIgnored();
      if (this.peek() === '=') {
        this.pos += 1;
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, required: type.endsWith('!'), defaultValue });
      this.skipIgnored();
      if (this.peek() === ',') this.pos += 1;
      this.skipIgnored();
    }
    this.expect(')');
    return defs;
  }

  private parseType(): string {
    this.skipIgnored();
    let type = '';
    if (this.peek() === '[') {
      this.pos += 1;
      type = `[${this.parseType()}]`;
    } else {
      type = this.readName();
    }
    this.skipIgnored();
    if (this.peek() === '!') {
      this.pos += 1;
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    this.skipIgnored();
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
      this.skipIgnored();
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    this.skipIgnored();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipIgnored();
      if (this.peekIsNameStart()) {
        const word = this.readName();
        if (word === 'on') {
          const typeCondition = this.readName();
          const children = this.parseSelectionSet();
          return { kind: 'inlineFragment', typeCondition, children };
        }
        return { kind: 'fragmentSpread', name: word };
      }
      const children = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition: null, children };
    }
    const first = this.readName();
    let alias: string | null = null;
    let name = first;
    this.skipIgnored();
    if (this.peek() === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    const args = this.peek() === '(' ? this.parseArgs() : [];
    // Directives (@include, @skip, ...): parsed and ignored.
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.parseArgs();
      this.skipIgnored();
    }
    const children = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, children };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expect('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.skipIgnored();
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
      this.skipIgnored();
      if (this.peek() === ',') this.pos += 1;
      this.skipIgnored();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    this.skipIgnored();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.parseString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      this.skipIgnored();
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        this.skipIgnored();
        if (this.peek() === ',') this.pos += 1;
        this.skipIgnored();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      this.skipIgnored();
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        this.skipIgnored();
        if (this.peek() === ',') this.pos += 1;
        this.skipIgnored();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    const word = this.readNameOrNumber();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(word)) return { kind: 'int', value: Number(word) };
    if (/^-?\d+\.\d+$/.test(word)) return { kind: 'float', value: Number(word) };
    return { kind: 'enum', value: word };
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      this.pos += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        const esc = this.text[this.pos] as string;
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
      } else {
        out += ch;
      }
    }
    throw new ParseError('unterminated string');
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  private peekIsNameStart(): boolean {
    const ch = this.peek();
    return /[A-Za-z_]/.test(ch);
  }

  private readName(): string {
    this.skipIgnored();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos] as string)) this.pos += 1;
    if (this.pos === start) throw new ParseError(`expected a name at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private readNameOrNumber(): string {
    this.skipIgnored();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_.\-]/.test(this.text[this.pos] as string)) this.pos += 1;
    if (this.pos === start) throw new ParseError(`expected a value at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private expect(ch: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== ch) throw new ParseError(`expected ${JSON.stringify(ch)} at offset ${this.pos}`);
    this.pos += 1;
  }

  private expectWord(word: string): void {
    const got = this.readName();
    if (got !== word) throw new ParseError(`expected ${JSON.stringify(word)}, got ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------- schema (introspection)

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM';
  readonly fields?: readonly string[];
  readonly enumValues?: readonly string[];
}

const SCHEMA_TYPES: Readonly<Record<string, TypeDef>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'url', 'author'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  readonly store: ForgeStore;
  readonly errors: Array<{ message: string }>;
  readonly fragments: ReadonlyMap<string, FragmentNode>;
  readonly variables: Record<string, unknown>;
}

type Entity =
  | { readonly __typename: 'Query' }
  | { readonly __typename: 'Mutation' }
  | { readonly __typename: 'User'; readonly login: string }
  | { readonly __typename: 'Repository'; readonly repo: Repo }
  | { readonly __typename: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'PullRequest'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'IssueConnection'; readonly nodes: Array<{ repo: Repo; issue: Issue }>; readonly pageInfo: PageInfoValue }
  | { readonly __typename: 'PullRequestConnection'; readonly nodes: Array<{ repo: Repo; pull: Pull }>; readonly pageInfo: PageInfoValue }
  | { readonly __typename: 'PullRequestChangedFileConnection'; readonly nodes: Array<{ path: string }>; readonly pageInfo: PageInfoValue }
  | { readonly __typename: 'PullRequestChangedFile'; readonly path: string }
  | { readonly __typename: 'PageInfo'; readonly value: PageInfoValue }
  | { readonly __typename: 'Ref'; readonly name: string }
  | { readonly __typename: 'CreateIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'CloseIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'CreatePullRequestPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'MergePullRequestPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'AddCommentPayload'; readonly repo: Repo; readonly issue: Issue; readonly commentId: number; readonly body: string }
  | { readonly __typename: 'IssueComment'; readonly id: string; readonly body: string }
  | { readonly __typename: 'IssueCommentEdge'; readonly node: Entity; readonly cursor: string }
  | { readonly __typename: '__Type'; readonly name: string }
  | { readonly __typename: 'Plain'; readonly value: Record<string, unknown> };

interface PageInfoValue {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function isEntity(value: unknown): value is Entity {
  return typeof value === 'object' && value !== null && '__typename' in value;
}

function executeSelections(ctx: ExecCtx, entity: Entity, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === entity.__typename) {
        Object.assign(out, executeSelections(ctx, entity, selection.children));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === entity.__typename) {
        Object.assign(out, executeSelections(ctx, entity, fragment.selections));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, entity, selection);
    if (value === undefined) continue;
    // List fields return Plain entities when they carry sub-selections; the
    // mapping is applied here so each resolver stays simple.
    if (selection.children !== null && Array.isArray(value)) {
      out[key] = value.map((item) => (isEntity(item) ? executeSelections(ctx, item, selection.children as readonly SelectionNode[]) : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function unknownField(ctx: ExecCtx, entity: Entity, field: FieldNode): undefined {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${entity.__typename}".` });
  return undefined;
}

function resolveField(ctx: ExecCtx, entity: Entity, field: FieldNode): unknown {
  const name = field.name;
  switch (entity.__typename) {
    case 'Query': {
      if (name === 'viewer') {
        if (field.children === null) return { __typename: 'User', login: VIEWER.login };
        return executeSelections(ctx, { __typename: 'User', login: VIEWER.login }, field.children);
      }
      if (name === 'repository') {
        const owner = argValue(field, 'owner', ctx.variables) as string | undefined;
        const repoName = argValue(field, 'name', ctx.variables) as string | undefined;
        if (owner !== VIEWER.login) return null;
        const repo = ctx.store.getRepo(owner ?? '', repoName ?? '');
        if (repo === undefined) return null;
        if (field.children === null) return { __typename: 'Repository', repo };
        return executeSelections(ctx, { __typename: 'Repository', repo }, field.children);
      }
      if (name === 'node') {
        const id = argValue(field, 'id', ctx.variables) as string | undefined;
        const decoded = id === undefined ? null : decodeId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
          if (repo === undefined) return null;
          if (field.children === null) return { __typename: 'Repository', repo };
          return executeSelections(ctx, { __typename: 'Repository', repo }, field.children);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argValue(field, 'name', ctx.variables) as string | undefined;
        if (typeName === undefined) return null;
        if (field.children === null) return { __typename: '__Type', name: typeName };
        return executeSelections(ctx, { __typename: '__Type', name: typeName }, field.children);
      }
      if (name === '__schema') {
        if (field.children === null) return {};
        const out: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.kind !== 'inlineFragment' && child.kind !== 'fragmentSpread') {
            if (child.name === 'queryType') out[child.alias ?? 'queryType'] = { name: 'Query' };
            else if (child.name === 'types') {
              out[child.alias ?? 'types'] = Object.keys(SCHEMA_TYPES).map((typeName) => ({ __typename: 'Plain', value: { name: typeName } }) as Entity);
            }
          }
        }
        return out;
      }
      return unknownField(ctx, entity, field);
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
        const result = mutateCreateIssue(ctx, input);
        if (result === null) return null;
        if (field.children === null) return result;
        return executeSelections(ctx, result, field.children);
      }
      if (name === 'closeIssue') {
        const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
        const result = mutateCloseIssue(ctx, input);
        if (result === null) return null;
        if (field.children === null) return result;
        return executeSelections(ctx, result, field.children);
      }
      if (name === 'createPullRequest') {
        const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
        const result = mutateCreatePullRequest(ctx, input);
        if (result === null) return null;
        if (field.children === null) return result;
        return executeSelections(ctx, result, field.children);
      }
      if (name === 'mergePullRequest') {
        const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
        const result = mutateMergePullRequest(ctx, input);
        if (result === null) return null;
        if (field.children === null) return result;
        return executeSelections(ctx, result, field.children);
      }
      if (name === 'addComment') {
        const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
        const result = mutateAddComment(ctx, input);
        if (result === null) return null;
        if (field.children === null) return result;
        return executeSelections(ctx, result, field.children);
      }
      return unknownField(ctx, entity, field);
    }
    case 'User': {
      if (name === 'login') return entity.login;
      if (name === 'id') return encodeId('User', [VIEWER.id]);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      return unknownField(ctx, entity, field);
    }
    case 'Repository': {
      const repo = entity.repo;
      if (name === 'id') return repoIdOf(repo);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') {
        if (field.children === null) return { __typename: 'User', login: repo.owner };
        return executeSelections(ctx, { __typename: 'User', login: repo.owner }, field.children);
      }
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        if (field.children === null) return { __typename: 'Ref', name: repo.defaultBranch };
        return executeSelections(ctx, { __typename: 'Ref', name: repo.defaultBranch }, field.children);
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'private') return repo.private;
      if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (name === 'createdAt') return repo.createdAt;
      if (name === 'updatedAt') return repo.updatedAt;
      if (name === 'issue') {
        const number = argValue(field, 'number', ctx.variables) as number | undefined;
        const issue = number === undefined ? undefined : repo.issueByNumber.get(number);
        if (issue === undefined) return null;
        if (field.children === null) return { __typename: 'Issue', repo, issue };
        return executeSelections(ctx, { __typename: 'Issue', repo, issue }, field.children);
      }
      if (name === 'issues') return resolveIssues(ctx, repo, field);
      if (name === 'pullRequest') {
        const number = argValue(field, 'number', ctx.variables) as number | undefined;
        const pull = number === undefined ? undefined : repo.pullByNumber.get(number);
        if (pull === undefined) return null;
        if (field.children === null) return { __typename: 'PullRequest', repo, pull };
        return executeSelections(ctx, { __typename: 'PullRequest', repo, pull }, field.children);
      }
      if (name === 'pullRequests') return resolvePullRequests(ctx, repo, field);
      return unknownField(ctx, entity, field);
    }
    case 'Issue': {
      const issue = entity.issue;
      if (name === 'id') return issueIdOf(entity.repo, issue);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'body') return issue.body;
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'url') return `https://github.com/${entity.repo.owner}/${entity.repo.name}/issues/${issue.number}`;
      if (name === 'author') {
        if (field.children === null) return { __typename: 'User', login: issue.userLogin };
        return executeSelections(ctx, { __typename: 'User', login: issue.userLogin }, field.children);
      }
      if (name === 'labels') return issue.labels.map((label) => ({ __typename: 'Plain', value: { name: label } }) as Entity);
      if (name === 'comments') return issue.comments.length;
      return unknownField(ctx, entity, field);
    }
    case 'PullRequest': {
      const pull = entity.pull;
      if (name === 'id') return pullIdOf(entity.repo, pull);
      if (name === 'number') return pull.number;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return ctx.store.mergeableState(entity.repo, pull);
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'merged') return pull.merged;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      if (name === 'url') return `https://github.com/${entity.repo.owner}/${entity.repo.name}/pulls/${pull.number}`;
      if (name === 'author') {
        if (field.children === null) return { __typename: 'User', login: pull.userLogin };
        return executeSelections(ctx, { __typename: 'User', login: pull.userLogin }, field.children);
      }
      if (name === 'files') {
        const first = argValue(field, 'first', ctx.variables) as number | undefined;
        const files = ctx.store.pullFiles(entity.repo, pull);
        const nodes = files.slice(0, first ?? files.length).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename } as Entity));
        const connection: Entity = {
          __typename: 'PullRequestChangedFileConnection',
          nodes: nodes.map((node) => ({ path: (node as { path: string }).path })),
          pageInfo: { hasNextPage: false, endCursor: null },
        };
        if (field.children === null) return connection;
        return executeSelections(ctx, connection, field.children);
      }
      return unknownField(ctx, entity, field);
    }
    case 'IssueConnection': {
      if (name === 'nodes') {
        if (field.children === null) return entity.nodes.map((node) => ({ __typename: 'Issue', repo: node.repo, issue: node.issue }));
        return entity.nodes.map((node) => executeSelections(ctx, { __typename: 'Issue', repo: node.repo, issue: node.issue }, field.children));
      }
      if (name === 'pageInfo') {
        if (field.children === null) return entity.pageInfo;
        return executeSelections(ctx, { __typename: 'PageInfo', value: entity.pageInfo }, field.children);
      }
      if (name === 'totalCount') return entity.nodes.length;
      return unknownField(ctx, entity, field);
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        if (field.children === null) return entity.nodes.map((node) => ({ __typename: 'PullRequest', repo: node.repo, pull: node.pull }));
        return entity.nodes.map((node) => executeSelections(ctx, { __typename: 'PullRequest', repo: node.repo, pull: node.pull }, field.children));
      }
      if (name === 'pageInfo') {
        if (field.children === null) return entity.pageInfo;
        return executeSelections(ctx, { __typename: 'PageInfo', value: entity.pageInfo }, field.children);
      }
      if (name === 'totalCount') return entity.nodes.length;
      return unknownField(ctx, entity, field);
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') {
        if (field.children === null) return entity.nodes.map((node) => ({ __typename: 'PullRequestChangedFile', path: node.path }));
        return entity.nodes.map((node) => executeSelections(ctx, { __typename: 'PullRequestChangedFile', path: node.path }, field.children));
      }
      if (name === 'pageInfo') {
        if (field.children === null) return entity.pageInfo;
        return executeSelections(ctx, { __typename: 'PageInfo', value: entity.pageInfo }, field.children);
      }
      return unknownField(ctx, entity, field);
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return entity.path;
      return unknownField(ctx, entity, field);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return entity.value.hasNextPage;
      if (name === 'endCursor') return entity.value.endCursor;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      return unknownField(ctx, entity, field);
    }
    case 'Ref': {
      if (name === 'name') return entity.name;
      return unknownField(ctx, entity, field);
    }
    case 'CreateIssuePayload': {
      if (name === 'issue') {
        if (field.children === null) return { __typename: 'Issue', repo: entity.repo, issue: entity.issue };
        return executeSelections(ctx, { __typename: 'Issue', repo: entity.repo, issue: entity.issue }, field.children);
      }
      if (name === 'clientMutationId') return null;
      return unknownField(ctx, entity, field);
    }
    case 'CloseIssuePayload': {
      if (name === 'issue') {
        if (field.children === null) return { __typename: 'Issue', repo: entity.repo, issue: entity.issue };
        return executeSelections(ctx, { __typename: 'Issue', repo: entity.repo, issue: entity.issue }, field.children);
      }
      if (name === 'clientMutationId') return null;
      return unknownField(ctx, entity, field);
    }
    case 'CreatePullRequestPayload': {
      if (name === 'pullRequest') {
        if (field.children === null) return { __typename: 'PullRequest', repo: entity.repo, pull: entity.pull };
        return executeSelections(ctx, { __typename: 'PullRequest', repo: entity.repo, pull: entity.pull }, field.children);
      }
      if (name === 'clientMutationId') return null;
      return unknownField(ctx, entity, field);
    }
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') {
        if (field.children === null) return { __typename: 'PullRequest', repo: entity.repo, pull: entity.pull };
        return executeSelections(ctx, { __typename: 'PullRequest', repo: entity.repo, pull: entity.pull }, field.children);
      }
      if (name === 'clientMutationId') return null;
      return unknownField(ctx, entity, field);
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        const node: Entity = { __typename: 'IssueComment', id: commentIdOf(entity.repo, entity.issue, entity.commentId), body: entity.body };
        const edge: Entity = { __typename: 'IssueCommentEdge', node, cursor: cursorFor(0) };
        if (field.children === null) return edge;
        return executeSelections(ctx, edge, field.children);
      }
      if (name === 'clientMutationId') return null;
      return unknownField(ctx, entity, field);
    }
    case 'IssueComment': {
      if (name === 'id') return entity.id;
      if (name === 'body') return entity.body;
      return unknownField(ctx, entity, field);
    }
    case 'IssueCommentEdge': {
      if (name === 'node') {
        if (field.children === null) return entity.node;
        return executeSelections(ctx, entity.node, field.children);
      }
      if (name === 'cursor') return entity.cursor;
      return unknownField(ctx, entity, field);
    }
    case '__Type': {
      const def = SCHEMA_TYPES[entity.name];
      if (name === 'name') return entity.name;
      if (name === 'kind') return def?.kind ?? null;
      if (name === 'fields') {
        if (def?.kind !== 'OBJECT') return null;
        return (def.fields ?? []).map((fieldName) => ({ __typename: 'Plain', value: { name: fieldName } }) as Entity);
      }
      if (name === 'enumValues') {
        if (def?.kind !== 'ENUM') return null;
        return (def.enumValues ?? []).map((value) => ({ __typename: 'Plain', value: { name: value } }) as Entity);
      }
      if (name === 'description') return null;
      return unknownField(ctx, entity, field);
    }
    case 'Plain': {
      const raw = entity.value[name];
      if (raw === undefined) return unknownField(ctx, entity, field);
      if (field.children === null) return raw;
      if (Array.isArray(raw)) {
        return raw.map((item) =>
          typeof item === 'object' && item !== null
            ? executeSelections(ctx, { __typename: 'Plain', value: item as Record<string, unknown> }, field.children as readonly SelectionNode[])
            : item,
        );
      }
      if (typeof raw === 'object' && raw !== null) {
        return executeSelections(ctx, { __typename: 'Plain', value: raw as Record<string, unknown> }, field.children as readonly SelectionNode[]);
      }
      return raw;
    }
  }
}

function resolveIssues(ctx: ExecCtx, repo: Repo, field: FieldNode): unknown {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const after = argValue(field, 'after', ctx.variables) as string | null | undefined;
  const states = argValue(field, 'states', ctx.variables) as unknown;
  const orderBy = argValue(field, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const direction = orderBy !== undefined && String(orderBy.direction ?? '') === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  const start = offsetOfCursor(after ?? null) + 1;
  const sliced = first === undefined ? list.slice(start) : list.slice(start, start + first);
  const pageInfo: PageInfoValue = {
    hasNextPage: start + sliced.length < list.length,
    endCursor: sliced.length === 0 ? null : cursorFor(start + sliced.length - 1),
  };
  const connection: Entity = {
    __typename: 'IssueConnection',
    nodes: sliced.map((issue) => ({ repo, issue })),
    pageInfo,
  };
  if (field.children === null) return connection;
  return executeSelections(ctx, connection, field.children);
}

function resolvePullRequests(ctx: ExecCtx, repo: Repo, field: FieldNode): unknown {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const after = argValue(field, 'after', ctx.variables) as string | null | undefined;
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const start = offsetOfCursor(after ?? null) + 1;
  const sliced = first === undefined ? list.slice(start) : list.slice(start, start + first);
  const pageInfo: PageInfoValue = {
    hasNextPage: start + sliced.length < list.length,
    endCursor: sliced.length === 0 ? null : cursorFor(start + sliced.length - 1),
  };
  const connection: Entity = {
    __typename: 'PullRequestConnection',
    nodes: sliced.map((pull) => ({ repo, pull })),
    pageInfo,
  };
  if (field.children === null) return connection;
  return executeSelections(ctx, connection, field.children);
}

// ---------------------------------------------------------------- mutations

function findRepoById(ctx: ExecCtx, repositoryId: unknown): Repo | null {
  if (typeof repositoryId !== 'string') return null;
  const decoded = decodeId(repositoryId);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const id = Number(decoded.parts[0]);
  return [...ctx.store.repos.values()].find((repo) => repo.id === id) ?? null;
}

function mutateCreateIssue(ctx: ExecCtx, input: Record<string, unknown> | undefined): Entity | null {
  if (input === undefined) {
    ctx.errors.push({ message: 'createIssue requires an input object.' });
    return null;
  }
  const repo = findRepoById(ctx, input.repositoryId);
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const issue = ctx.store.createIssue(repo, title, body, []);
  return { __typename: 'CreateIssuePayload', repo, issue };
}

function mutateCloseIssue(ctx: ExecCtx, input: Record<string, unknown> | undefined): Entity | null {
  if (input === undefined) {
    ctx.errors.push({ message: 'closeIssue requires an input object.' });
    return null;
  }
  const decoded = typeof input.issueId === 'string' ? decodeId(input.issueId) : null;
  if (decoded === null || decoded.kind !== 'Issue') {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return null;
  }
  const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const issue = repo?.issueByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return null;
  }
  issue.state = 'closed';
  issue.updatedAt = ctx.store.nowIso();
  return { __typename: 'CloseIssuePayload', repo, issue };
}

function mutateCreatePullRequest(ctx: ExecCtx, input: Record<string, unknown> | undefined): Entity | null {
  if (input === undefined) {
    ctx.errors.push({ message: 'createPullRequest requires an input object.' });
    return null;
  }
  const repo = findRepoById(ctx, input.repositoryId);
  if (repo === null) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
    return null;
  }
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const pull = ctx.store.createPull(repo, title, body, head, base);
  if (pull === null) {
    ctx.errors.push({ message: `Could not create a pull request from ${head} into ${base}.` });
    return null;
  }
  return { __typename: 'CreatePullRequestPayload', repo, pull };
}

function mutateMergePullRequest(ctx: ExecCtx, input: Record<string, unknown> | undefined): Entity | null {
  if (input === undefined) {
    ctx.errors.push({ message: 'mergePullRequest requires an input object.' });
    return null;
  }
  const decoded = typeof input.pullRequestId === 'string' ? decodeId(input.pullRequestId) : null;
  if (decoded === null || decoded.kind !== 'PullRequest') {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
    return null;
  }
  const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const pull = repo?.pullByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || pull === undefined) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
    return null;
  }
  if (pull.merged) return { __typename: 'MergePullRequestPayload', repo, pull };
  const sha = ctx.store.mergePull(repo, pull);
  if (sha === null) {
    ctx.errors.push({ message: 'This pull request cannot be merged: it conflicts with the base branch.' });
    return null;
  }
  return { __typename: 'MergePullRequestPayload', repo, pull };
}

function mutateAddComment(ctx: ExecCtx, input: Record<string, unknown> | undefined): Entity | null {
  if (input === undefined) {
    ctx.errors.push({ message: 'addComment requires an input object.' });
    return null;
  }
  const decoded = typeof input.subjectId === 'string' ? decodeId(input.subjectId) : null;
  if (decoded === null || decoded.kind !== 'Issue') {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return null;
  }
  const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(decoded.parts[0]));
  const issue = repo?.issueByNumber.get(Number(decoded.parts[1]));
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return null;
  }
  const body = typeof input.body === 'string' ? input.body : '';
  const comment = ctx.store.createComment(issue, body);
  return { __typename: 'AddCommentPayload', repo, issue, commentId: comment.id, body };
}

// ---------------------------------------------------------------- dispatch

interface GraphQLOperation {
  readonly query?: unknown;
  readonly variables?: unknown;
  readonly operationName?: unknown;
}

function executeOne(
  store: ForgeStore,
  operation: GraphQLOperation,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = (operation.variables !== undefined && typeof operation.variables === 'object' && operation.variables !== null
    ? (operation.variables as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
  const op =
    document.operations.find((candidate) => operationName !== null && candidate.name === operationName) ??
    document.operations[0];
  if (op === undefined) return { data: null, errors: [{ message: 'No operation found in the document.' }] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (mergedVariables[def.name] === undefined && def.defaultValue !== null) {
      mergedVariables[def.name] = resolveValue(def.defaultValue, mergedVariables);
    }
  }
  const ctx: ExecCtx = { store, errors: [], fragments: document.fragments, variables: mergedVariables };
  const root: Entity = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(ctx, root, op.selections);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle POST /api/graphql (auth is checked by app.ts before this runs). */
export function handleGraphQL(store: ForgeStore, ctx: ReqCtx): Resp {
  if (ctx.jsonError) return err(400, 'Problems parsing JSON');
  const parsed = ctx.json;
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      typeof entry === 'object' && entry !== null ? executeOne(store, entry as GraphQLOperation) : { data: null, errors: [{ message: 'Expected a GraphQL operation object.' }] },
    );
    return { status: 200, body: results };
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    return { status: 200, body: executeOne(store, parsed as GraphQLOperation) };
  }
  return err(400, 'Expected a GraphQL operation object.');
}
