// The forge's store: every repository, issue, pull request, label and
// comment, and every git object and ref, in memory. REST, git smart HTTP,
// GraphQL and MCP all read and write this one store, so an object created
// over one surface reads back over the others with the same id.
//
// Determinism: nothing here reads a wall clock or Math.random. Timestamps
// come from MAKEFUN_TRIAL_NOW when the trial sets it, else the scenario's
// fixed epoch, advanced one second per creation event — so two runs of one
// trial stamp the same values in the same order. Ids and numbers are
// counters in creation order.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  ident,
  isOid,
  makeObject,
  parseCommit,
  parseTree,
  type CommitView,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';

export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/** The trial's "now": MAKEFUN_TRIAL_NOW when set, else the fixed epoch. */
function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
  }
  return SCENARIO_EPOCH_SEC;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: Comment[];
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** The base tip when the pull was opened: the merge-base for conflicts. */
  readonly baseShaAtOpen: string;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Git objects by oid. */
  readonly objects: Map<string, GitObject>;
  /** Refs by full name (refs/heads/main, refs/tags/v1). */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly issueByNumber: Map<number, Issue>;
  readonly pulls: Pull[];
  readonly pullByNumber: Map<number, Pull>;
  /** The next shared issue/pull-request number for this repository. */
  nextNumber: number;
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private clockSec: number;

  constructor() {
    this.clockSec = trialEpochSec();
  }

  /** A deterministic timestamp; each call advances the clock one second. */
  nowIso(): string {
    const iso = new Date(this.clockSec * 1000).toISOString();
    this.clockSec += 1;
    return iso;
  }

  /** A deterministic epoch second for a git commit; advances the clock. */
  nowEpochSec(): number {
    const sec = this.clockSec;
    this.clockSec += 1;
    return sec;
  }

  // ---------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      issueByNumber: new Map<number, Issue>(),
      pulls: [],
      pullByNumber: new Map<number, Pull>(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    for (const label of DEFAULT_LABELS) repo.labels.set(label.name, label);
    this.repos.set(this.repoKey(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER.login) out.push(repo);
    return out;
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, makeObject(type, data));
    return oid;
  }

  putExistingObject(repo: Repo, obj: GitObject): string {
    const oid = hashObject(obj.type, obj.data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit object at a ref, or undefined when the ref is unborn. */
  refCommit(repo: Repo, ref: string): { oid: string; view: CommitView } | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return { oid, view: parseCommit(obj.data) };
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`);
  }

  /** Every commit reachable from `tip`, newest first by committer time. */
  walkCommits(repo: Repo, tip: string): Array<{ oid: string; view: CommitView }> {
    const seen = new Set<string>();
    const out: Array<{ oid: string; view: CommitView; time: number }> = [];
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      const time = committerTime(view.committer);
      out.push({ oid, view, time });
      for (const parent of view.parents) stack.push(parent);
    }
    out.sort((a, b) => (b.time - a.time) || (a.oid < b.oid ? 1 : -1));
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** A common ancestor of `a` and `b`, or undefined when the histories share none. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
    }
    return undefined;
  }

  // ---------------------------------------------------------- trees

  /** The flat path -> entry map of a tree, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [subPath, subEntry] of this.flattenTree(repo, entry.oid, path)) out.set(subPath, subEntry);
      } else {
        out.set(path, entry);
      }
    }
    return out;
  }

  /** Build (and store) the nested trees for a flat path map; returns the root oid. */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, TreeEntry>): string {
    const files = new Map<string, TreeEntry[]>();
    const children = new Map<string, Set<string>>();
    const ensureDir = (dir: string): void => {
      if (!files.has(dir)) files.set(dir, []);
      if (!children.has(dir)) children.set(dir, new Set<string>());
    };
    ensureDir('');
    for (const [path, entry] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      ensureDir(dir);
      (files.get(dir) as TreeEntry[]).push({ mode: entry.mode, name, oid: entry.oid });
      let cur = dir;
      while (cur !== '') {
        const slash = cur.lastIndexOf('/');
        const parent = slash === -1 ? '' : cur.slice(0, slash);
        const base = slash === -1 ? cur : cur.slice(slash + 1);
        ensureDir(parent);
        (children.get(parent) as Set<string>).add(base);
        cur = parent;
      }
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [...(files.get(dir) ?? [])];
      for (const child of children.get(dir) ?? []) {
        entries.push({ mode: '40000', name: child, oid: buildDir(dir === '' ? child : `${dir}/${child}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /**
   * The file-level difference between two trees: path -> the old and new
   * blob oids (null when the file is added or removed).
   */
  diffTrees(
    repo: Repo,
    baseTreeOid: string,
    otherTreeOid: string,
  ): Map<string, { oldOid: string | null; newOid: string | null; mode: string }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const other = this.flattenTree(repo, otherTreeOid);
    const out = new Map<string, { oldOid: string | null; newOid: string | null; mode: string }>();
    for (const [path, entry] of base) {
      const next = other.get(path);
      if (next === undefined) out.set(path, { oldOid: entry.oid, newOid: null, mode: entry.mode });
      else if (next.oid !== entry.oid) out.set(path, { oldOid: entry.oid, newOid: next.oid, mode: next.mode });
    }
    for (const [path, entry] of other) {
      if (!base.has(path)) out.set(path, { oldOid: null, newOid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  // ---------------------------------------------------------- contents

  /** The blob at `path` on a ref's tip, or undefined. */
  fileAt(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const commitObj = repo.objects.get(tip);
    if (commitObj === undefined || commitObj.type !== 'commit') return undefined;
    const treeOid = parseCommit(commitObj.data).tree;
    const flat = this.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry === undefined) return undefined;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined || blob.type !== 'blob') return undefined;
    return { oid: entry.oid, data: blob.data };
  }

  /** The directory listing at `path` on a ref's tip ('' is the root). */
  dirAt(repo: Repo, ref: string, path: string): TreeEntry[] | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const commitObj = repo.objects.get(tip);
    if (commitObj === undefined || commitObj.type !== 'commit') return undefined;
    let treeOid = parseCommit(commitObj.data).tree;
    if (path !== '') {
      const parts = path.split('/');
      let current = treeOid;
      for (const part of parts) {
        const obj = repo.objects.get(current);
        if (obj === undefined || obj.type !== 'tree') return undefined;
        const next = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
        if (next === undefined) return undefined;
        current = next.oid;
      }
      treeOid = current;
    }
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    return parseTree(obj.data);
  }

  /**
   * Write a file on a branch (creating the branch's first commit when it is
   * unborn) and return the blob and commit oids.
   */
  writeFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { blobOid: string; commitOid: string } {
    const ref = `refs/heads/${branch}`;
    const current = this.refCommit(repo, ref);
    const blobOid = this.putObject(repo, 'blob', content);
    const baseTree = current === undefined ? '' : current.view.tree;
    const flat = baseTree === '' ? new Map<string, TreeEntry>() : this.flattenTree(repo, baseTree);
    flat.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blobOid });
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const epoch = this.nowEpochSec();
    const author = ident(VIEWER.name, VIEWER.email, epoch);
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: current === undefined ? [] : [current.oid],
        author,
        committer: author,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(ref, commitOid);
    return { blobOid, commitOid };
  }

  /**
   * Delete a file from a branch; returns the new commit oid, or null when
   * the file is not on the branch.
   */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const current = this.refCommit(repo, ref);
    if (current === undefined) return null;
    const flat = this.flattenTree(repo, current.view.tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const epoch = this.nowEpochSec();
    const author = ident(VIEWER.name, VIEWER.email, epoch);
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [current.oid],
        author,
        committer: author,
        message: message.endsWith('\n') ? message : `${message}\n`,
      }),
    );
    repo.refs.set(ref, commitOid);
    return commitOid;
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  createComment(issue: Issue, body: string): Comment {
    const now = this.nowIso();
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      userLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headOid = this.resolveRef(repo, headRef);
    const baseOid = this.resolveRef(repo, baseRef);
    if (headOid === undefined || baseOid === undefined) return null;
    const now = this.nowIso();
    const pull: Pull = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha: headOid,
      baseSha: baseOid,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      baseShaAtOpen: baseOid,
      userLogin: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }

  /** The files a pull request changes, base tip vs head tip. */
  pullFiles(repo: Repo, pull: Pull): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const baseCommit = repo.objects.get(pull.baseSha);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit === undefined || headCommit === undefined) return [];
    const diff = this.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const oldText = change.oldOid === null ? '' : blobText(repo, change.oldOid);
      const newText = change.newOid === null ? '' : blobText(repo, change.newOid);
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({
        filename: path,
        status: change.oldOid === null ? 'added' : change.newOid === null ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the squash
   * commit oid, or null when the merge conflicts (both sides changed the
   * same file to different content since the merge-base).
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    const base = this.mergeBase(repo, baseTip, headTip) ?? pull.baseShaAtOpen;
    const baseCommit = repo.objects.get(base);
    const oursCommit = repo.objects.get(baseTip);
    const theirsCommit = repo.objects.get(headTip);
    if (baseCommit === undefined || oursCommit === undefined || theirsCommit === undefined) return null;
    const baseTree = parseCommit(baseCommit.data).tree;
    const oursTree = parseCommit(oursCommit.data).tree;
    const theirsTree = parseCommit(theirsCommit.data).tree;
    const oursDiff = this.diffTrees(repo, baseTree, oursTree);
    const theirsDiff = this.diffTrees(repo, baseTree, theirsTree);
    const merged = this.flattenTree(repo, oursTree);
    for (const [path, change] of theirsDiff) {
      const oursChange = oursDiff.get(path);
      if (oursChange !== undefined) {
        const oursOid = oursChange.newOid;
        const theirsOid = change.newOid;
        if (oursOid !== theirsOid) return null; // both sides changed it differently: conflict
        continue;
      }
      if (change.newOid === null) merged.delete(path);
      else merged.set(path, { mode: change.mode, name: path.split('/').pop() as string, oid: change.newOid });
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const epoch = this.nowEpochSec();
    const author = ident(VIEWER.name, VIEWER.email, epoch);
    const message = `${pull.title} (#${pull.number})\n`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], author, committer: author, message }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(epoch * 1000).toISOString();
    pull.mergeCommitSha = commitOid;
    pull.updatedAt = pull.mergedAt;
    pull.baseSha = commitOid;
    return commitOid;
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for a pull request, three-way. */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged) return 'MERGEABLE';
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    if (this.isAncestor(repo, headTip, baseTip)) return 'MERGEABLE';
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === undefined) return 'UNKNOWN';
    const baseCommit = repo.objects.get(base);
    const oursCommit = repo.objects.get(baseTip);
    const theirsCommit = repo.objects.get(headTip);
    if (baseCommit === undefined || oursCommit === undefined || theirsCommit === undefined) return 'UNKNOWN';
    const baseTree = parseCommit(baseCommit.data).tree;
    const oursDiff = this.diffTrees(repo, baseTree, parseCommit(oursCommit.data).tree);
    const theirsDiff = this.diffTrees(repo, baseTree, parseCommit(theirsCommit.data).tree);
    for (const [path, change] of theirsDiff) {
      const oursChange = oursDiff.get(path);
      if (oursChange !== undefined && oursChange.newOid !== change.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

/** The labels every new repository is born with (GitHub's defaults). */
export const DEFAULT_LABELS: readonly Label[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: 'This doesn\'t seem right' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** Added/removed line counts between two texts (common prefix + suffix). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** The committer timestamp of a commit's committer line, or 0. */
export function committerTime(committer: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return match === null ? 0 : Number(match[1]);
}

/** True when `value` is a 40-hex object id. */
export function isOidValue(value: string): boolean {
  return isOid(value);
}
