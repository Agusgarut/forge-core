// Git smart HTTP: upload-pack protocol v2 (with a v0 fallback) and
// receive-pack v0, on /{owner}/{repo}.git. The forge implements the wire
// itself — pkt-line framing, packfile reading and writing — on gitobj.ts.
// No git binary anywhere.
//
//   GET  /{o}/{r}.git/info/refs?service=git-upload-pack   v2 or v0 advertisement
//   GET  /{o}/{r}.git/info/refs?service=git-receive-pack  v0 advertisement
//   POST /{o}/{r}.git/git-upload-pack                     ls-refs / fetch
//   POST /{o}/{r}.git/git-receive-pack                    push + report-status
//
// A missing repository is 404 on info/refs and the server keeps serving.
// Every update must fast-forward: a non-fast-forward ref is refused per ref
// with "ng <ref> non-fast-forward" and the ref does not move.

import {
  ZERO_OID,
  decodePktLines,
  decodePktLinesUntilFlush,
  encodePktLine,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
  type PktLinePacket,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';
import { type ForgeStore, type Repo } from './store.ts';
import { type ReqCtx, type Resp, err, notFound } from './rest.ts';

const AGENT = 'forge-core/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS = `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
const V2_CAPS = [
  'ls-refs=unborn peel symrefs ref-prefix',
  'fetch=shallow ofs-delta filter',
  'object-format=sha1',
  `agent=${AGENT}`,
];

function raw(status: number, body: Buffer, contentType: string): Resp {
  return { status, body, raw: true, contentType };
}

/** The repository a git request names, or the 404 to answer instead. */
function gitRepo(store: ForgeStore, owner: string, repoName: string): Repo | Resp {
  if (owner !== VIEWER.login) return notFound('Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound('Not Found');
  return repo;
}

function isRepo(value: Repo | Resp): value is Repo {
  return (value as Repo).objects !== undefined;
}

/** All refs, HEAD first, then heads, then tags, each sorted. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const head = repo.refs.get('refs/heads/main');
  if (head !== undefined) out.push({ name: 'HEAD', oid: head });
  const heads: Array<{ name: string; oid: string }> = [];
  const tags: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
  }
  heads.sort((a, b) => (a.name < b.name ? -1 : 1));
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  return [...out, ...heads, ...tags];
}

/** The commit a tag object peels to, or undefined. */
function peeledOid(store: ForgeStore, repo: Repo, tagOid: string): string | undefined {
  const obj = store.getObject(repo, tagOid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const target = parseTag(obj.data).object;
  const targetObj = store.getObject(repo, target);
  if (targetObj === undefined) return undefined;
  if (targetObj.type === 'commit') return target;
  if (targetObj.type === 'tag') return peeledOid(store, repo, target);
  return undefined;
}

// ---------------------------------------------------------------- advertisements

function advertiseV0Upload(store: ForgeStore, repo: Repo): Buffer {
  // Smart HTTP framing: the '# service' line is followed by a flush before
  // the ref lines; real git rejects the advertisement without it.
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${V0_UPLOAD_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${V0_UPLOAD_CAPS}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${caps}\n`));
      const peeled = store.getObject(repo, ref.oid)?.type === 'tag' ? peeledOid(store, repo, ref.oid) : undefined;
      if (peeled !== undefined) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function advertiseV0Receive(store: ForgeStore, repo: Repo): Buffer {
  // Smart HTTP framing: the '# service' line is followed by a flush before
  // the ref lines; real git rejects the advertisement without it.
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${V0_RECEIVE_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const caps = index === 0 ? `\0${V0_RECEIVE_CAPS}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${caps}\n`));
      const peeled = store.getObject(repo, ref.oid)?.type === 'tag' ? peeledOid(store, repo, ref.oid) : undefined;
      if (peeled !== undefined) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  // Smart HTTP framing: the '# service' line is followed by a flush before
  // the 'version 2' line; real git rejects the advertisement without it.
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    encodePktLine('version 2\n'),
  ];
  for (const cap of V2_CAPS) parts.push(encodePktLine(`${cap}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsV2(store: ForgeStore, repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn) parts.push(encodePktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.symrefs && ref.name === 'HEAD') line += ' symref-target:refs/heads/main';
      if (args.peel) {
        const peeled = store.getObject(repo, ref.oid)?.type === 'tag' ? peeledOid(store, repo, ref.oid) : undefined;
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch object selection

interface FetchSelection {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly wantedRefs: Array<{ oid: string; ref: string }>;
}

/**
 * The objects a fetch must send: everything reachable from `wants` except
 * what the client already has (`haves`, unless shallow) and everything past
 * the depth cutoff. `shallowExisting` are the commits the client already
 * holds shallow; deepening past one makes it `unshallow`.
 */
function selectFetchObjects(
  store: ForgeStore,
  repo: Repo,
  wants: readonly string[],
  haves: ReadonlySet<string>,
  depth: number | null,
  shallowExisting: ReadonlySet<string>,
): FetchSelection {
  const included = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (wants.includes(oid)) wantedRefs.push({ oid, ref: name });
  }

  // Everything the client already holds: each have plus its whole reachable
  // closure (commits, trees, blobs, tag targets). Re-sending any of those
  // is what the incremental-fetch check counts against us, so the walk
  // below excludes them all.
  const held = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = store.getObject(repo, oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        stack.push(view.tree);
        // A shallow-boundary commit's ancestry is NOT held: the client has
        // the commit and its tree, but none of its parents. (Deepening a
        // shallow fetch is precisely asking for those parents.)
        if (!shallowExisting.has(oid)) {
          for (const parent of view.parents) stack.push(parent);
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }

  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    const seenTrees = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seenTrees.has(oid)) continue;
      seenTrees.add(oid);
      if (held.has(oid)) continue;
      const obj = store.getObject(repo, oid);
      if (obj === undefined || obj.type !== 'tree') continue;
      included.set(oid, obj);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') {
          stack.push(entry.oid);
        } else {
          if (held.has(entry.oid)) continue;
          const blob = store.getObject(repo, entry.oid);
          if (blob !== undefined) included.set(entry.oid, blob);
        }
      }
    }
  };

  // Resolve wanted tag objects to their targets first.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = store.getObject(repo, want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!held.has(want)) included.set(want, obj);
      const target = parseTag(obj.data).object;
      const targetObj = store.getObject(repo, target);
      if (targetObj !== undefined && targetObj.type === 'commit') wantCommits.push(target);
      else if (targetObj !== undefined && targetObj.type === 'tag') {
        // A tag of a tag: include the chain's target commit.
        let current: string | undefined = target;
        while (current !== undefined) {
          const currentObj = store.getObject(repo, current);
          if (currentObj === undefined) break;
          if (!held.has(current)) included.set(current, currentObj);
          if (currentObj.type !== 'tag') break;
          current = parseTag(currentObj.data).object;
        }
        if (current !== undefined) wantCommits.push(current);
      }
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
  }

  const seen = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wantCommits.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; dist: number };
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    // A shallow-boundary commit the client already has must still be sent
    // when the fetch deepens past it (it becomes unshallow); everything
    // else the client holds is skipped, with its whole closure.
    if (held.has(item.oid) && !shallowExisting.has(item.oid)) continue;
    const obj = store.getObject(repo, item.oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    included.set(item.oid, obj);
    includeTree(parseCommit(obj.data).tree);
    const atBoundary = depth !== null && item.dist >= depth - 1;
    if (atBoundary) {
      shallow.push(item.oid);
      continue;
    }
    if (shallowExisting.has(item.oid)) unshallow.push(item.oid);
    for (const parent of parseCommit(obj.data).parents) {
      queue.push({ oid: parent, dist: item.dist + 1 });
    }
  }

  const objects = [...included.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return { objects, shallow, unshallow, wantedRefs };
}

/** A packfile wrapped in sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  ofsDelta: boolean;
  /** The client sent `done`: negotiation is over, the packfile follows. */
  done: boolean;
  /** Refs the client asked for with `want-ref <ref>` lines. */
  wantRefs: string[];
}

function commonAcks(
  store: ForgeStore,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
): string[] {
  const acks: string[] = [];
  for (const have of haves) {
    if (wants.some((want) => store.isAncestor(repo, have, want))) acks.push(have);
  }
  return acks;
}

function fetchV2(store: ForgeStore, repo: Repo, args: FetchArgs): Buffer {
  const haves = new Set(args.haves);
  const shallowExisting = new Set(args.shallow);
  const selection = selectFetchObjects(store, repo, args.wants, haves, args.depth, shallowExisting);
  const parts: Buffer[] = [];
  // acknowledgments: protocol-v2 says that when the client sent `done`
  // (negotiation over, a packfile is required) the acknowledgments section
  // MUST be omitted from the response. Real git dies on it ("expected
  // 'packfile', received 'acknowledgments'"); the section only belongs in
  // a negotiation round, where the server answers NAK/ACKs plus `ready`,
  // since it always has a cut point and sends the packfile at once.
  if (!args.done) {
    parts.push(encodePktLine('acknowledgments\n'));
    const acks = commonAcks(store, repo, args.wants, args.haves);
    if (acks.length === 0) {
      parts.push(encodePktLine('NAK\n'));
    } else {
      for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    }
    parts.push(encodePktLine('ready\n'));
    parts.push(pktLineDelim());
  }
  // shallow-info
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  // wanted-refs: only for refs the client asked for with `want-ref` lines.
  const wanted = selection.wantedRefs.filter((ref) => args.wantRefs.includes(ref.ref));
  if (wanted.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const ref of wanted) parts.push(encodePktLine(`${ref.oid} ${ref.ref}\n`));
    parts.push(pktLineDelim());
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(writePack(selection.objects)));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 fetch

interface FetchV0Args {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchV0(store: ForgeStore, repo: Repo, args: FetchV0Args): Buffer {
  const haves = new Set(args.haves);
  const shallowExisting = new Set(args.shallow);
  const selection = selectFetchObjects(store, repo, args.wants, haves, args.depth, shallowExisting);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const acks = commonAcks(store, repo, args.wants, args.haves);
  if (acks.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  }
  parts.push(sidebandPack(writePack(selection.objects)));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function receivePack(store: ForgeStore, repo: Repo, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let packOffset = body.length;
  let sideband = false;
  let parseError: string | null = null;
  try {
    // The command section ends at the first flush; a raw packfile follows.
    const { packets, consumed } = decodePktLinesUntilFlush(body);
    packOffset = consumed;
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') lines.push(packet.data.toString('utf8'));
    }
    commands = lines
      .map((line) => line.replace(/\n$/, ''))
      .filter((line) => line !== '')
      .map((line, index) => {
        const nul = line.indexOf('\0');
        const head = nul === -1 ? line : line.slice(0, nul);
        if (index === 0 && nul !== -1) {
          const caps = line.slice(nul + 1).split(' ');
          sideband = caps.includes('side-band-64k');
        }
        const parts = head.split(' ');
        if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
          throw new Error(`bad push command ${JSON.stringify(line)}`);
        }
        return { oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string };
      });
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  let report = '';
  if (parseError !== null) {
    report = `unpack ${parseError}\n`;
    for (const command of commands) report += `ng ${command.ref} unpack failed\n`;
  } else {
    const packBytes = body.subarray(packOffset);
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        const { objects } = readPack(packBytes, (oid) => store.getObject(repo, oid));
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        unpackOk = false;
        report = `unpack ${detail}\n`;
        for (const command of commands) report += `ng ${command.ref} unpack failed\n`;
      }
    }
    if (unpackOk) {
      report = 'unpack ok\n';
      for (const command of commands) {
        report += applyPushCommand(store, repo, command);
      }
    }
  }
  if (sideband) {
    // With side-band-64k the report-status stream is itself pkt-lined
    // inside band 1 (real git's receive-pack trace shows one sideband
    // packet carrying `000eunpack ok\n` + `0017ok <ref>\n` + an inner
    // flush, then an outer flush): each status line is its own pkt-line
    // inside the band-1 payload, never raw text and never one sideband
    // packet per line.
    const lines = report.split('\n').filter((line) => line !== '');
    const inner = Buffer.concat([...lines.map((line) => encodePktLine(`${line}\n`)), pktLineFlush()]);
    const parts: Buffer[] = [];
    for (let off = 0; off < inner.length; off += 65515) {
      const chunk = inner.subarray(off, Math.min(inner.length, off + 65515));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(pktLineFlush());
    return Buffer.concat(parts);
  }
  const lines = report.split('\n').filter((line) => line !== '');
  const parts = lines.map((line) => encodePktLine(`${line}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Apply one push command; returns its report line. */
function applyPushCommand(store: ForgeStore, repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${command.ref} ref does not exist\n`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return `ng ${command.ref} non-fast-forward\n`;
    }
    repo.refs.delete(command.ref);
    return `ok ${command.ref}\n`;
  }
  const obj = store.getObject(repo, command.newOid);
  // A tag ref points at a tag (or directly at a commit); a branch ref only
  // ever points at a commit.
  const isTagRef = command.ref.startsWith('refs/tags/');
  if (obj === undefined || (isTagRef ? obj.type !== 'commit' && obj.type !== 'tag' : obj.type !== 'commit')) {
    return `ng ${command.ref} object not found\n`;
  }
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${command.ref} non-fast-forward\n`;
    repo.refs.set(command.ref, command.newOid);
    return `ok ${command.ref}\n`;
  }
  if (current === undefined) return `ng ${command.ref} non-fast-forward\n`;
  if (command.oldOid !== current) return `ng ${command.ref} non-fast-forward\n`;
  if (command.newOid === current) return `ok ${command.ref}\n`;
  // Tags never fast-forward: moving one needs a delete plus a create.
  if (isTagRef) return `ng ${command.ref} non-fast-forward\n`;
  if (!store.isAncestor(repo, current, command.newOid)) {
    return `ng ${command.ref} non-fast-forward\n`;
  }
  repo.refs.set(command.ref, command.newOid);
  return `ok ${command.ref}\n`;
}

// ---------------------------------------------------------------- dispatch

/** The text lines of data packets, without trailing newlines. */
function dataLines(packets: readonly PktLinePacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.data.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split v2 request packets into the header section and the argument section. */
function splitV2Sections(packets: readonly PktLinePacket[]): { header: string[]; args: string[] } {
  const header: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') {
      const line = packet.data.toString('utf8').replace(/\n$/, '');
      if (inArgs) args.push(line);
      else header.push(line);
    }
  }
  return { header, args };
}

/** Handle a git smart-HTTP request, or null when the path is not one. */
export function handleGit(store: ForgeStore, ctx: ReqCtx): Resp | null {
  const seg = ctx.segments;
  if (seg.length < 2) return null;
  const repoSegment = seg[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = seg[0] as string;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const tail = seg.slice(2);
  if (tail.length === 0) return null;
  const found = gitRepo(store, owner, repoName);
  if (!isRepo(found)) return found;
  const repo = found;
  const method = ctx.method;

  // GET /{o}/{r}.git/info/refs?service=...
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (isV2) return raw(200, advertiseV2(), UPLOAD_ADVERTISEMENT);
      return raw(200, advertiseV0Upload(store, repo), UPLOAD_ADVERTISEMENT);
    }
    if (service === 'git-receive-pack') {
      return raw(200, advertiseV0Receive(store, repo), RECEIVE_ADVERTISEMENT);
    }
    return err(400, 'service is required');
  }

  // POST /{o}/{r}.git/git-upload-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const isV2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
    try {
      const { packets } = decodePktLines(ctx.body);
      if (isV2) {
        const { header, args } = splitV2Sections(packets);
        const command = header.find((line) => line.startsWith('command='))?.slice('command='.length) ?? '';
        if (command === 'ls-refs') {
          const lsArgs: LsRefsArgs = {
            peel: args.includes('peel'),
            symrefs: args.includes('symrefs'),
            unborn: args.includes('unborn'),
            prefixes: args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length)),
          };
          return raw(200, lsRefsV2(store, repo, lsArgs), UPLOAD_RESULT);
        }
        if (command === 'fetch') {
          const fetchArgs: FetchArgs = {
            wants: [],
            haves: [],
            shallow: [],
            depth: null,
            thinPack: false,
            ofsDelta: false,
            done: false,
            wantRefs: [],
          };
          for (const arg of args) {
            if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
            else if (arg.startsWith('want-ref ')) fetchArgs.wantRefs.push(arg.slice(9).trim());
            else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
            else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
            else if (arg.startsWith('deepen ')) fetchArgs.depth = Number(arg.slice(7).trim());
            else if (arg === 'thin-pack') fetchArgs.thinPack = true;
            else if (arg === 'ofs-delta') fetchArgs.ofsDelta = true;
            else if (arg === 'done') fetchArgs.done = true;
          }
          return raw(200, fetchV2(store, repo, fetchArgs), UPLOAD_RESULT);
        }
        return err(400, `unknown upload-pack v2 command ${JSON.stringify(command)}`);
      }
      // v0 fetch: wants, flush, haves + done, flush. The lines carry their
      // own kind, so section tracking is unnecessary: wants only precede
      // the first flush, haves and done only follow it.
      const lines = dataLines(packets);
      const fetchArgs: FetchV0Args = { wants: [], haves: [], shallow: [], depth: null };
      for (const line of lines) {
        if (line === '') continue;
        if (line.startsWith('want ')) {
          const parts = line.split(' ');
          fetchArgs.wants.push(parts[1] as string);
        } else if (line.startsWith('have ')) {
          fetchArgs.haves.push(line.slice(5).trim());
        } else if (line.startsWith('shallow ')) {
          fetchArgs.shallow.push(line.slice(8).trim());
        } else if (line.startsWith('deepen ')) {
          fetchArgs.depth = Number(line.slice(7).trim());
        }
      }
      return raw(200, fetchV0(store, repo, fetchArgs), UPLOAD_RESULT);
    } catch (error) {
      return err(400, error instanceof Error ? error.message : String(error));
    }
  }

  // POST /{o}/{r}.git/git-receive-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    try {
      return raw(200, receivePack(store, repo, ctx.body), RECEIVE_RESULT);
    } catch (error) {
      return err(400, error instanceof Error ? error.message : String(error));
    }
  }

  return null;
}
