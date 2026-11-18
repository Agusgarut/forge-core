// The git object layer: object hashing, trees and commits, delta application,
// packfile reading and writing, and pkt-line framing. Everything the forge's
// smart-HTTP surface speaks, on node:crypto (SHA-1) and node:zlib only —
// no git binary, no dependency.
//
// Packs the forge writes are plain (no deltas): every entry is a whole
// object, zlib-deflated once and cached on the object, so a clone or fetch
// of the same objects reuses the same bytes instead of recompressing them.
// Packs the forge reads may carry OFS_DELTA and REF_DELTA entries (thin
// packs included); they are resolved against the pack itself and, for a thin
// pack, against objects the repository already holds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  /** Cached zlib bytes of `data`, filled on first pack build. */
  deflated: Buffer | null;
}

export const ZERO_OID = '0'.repeat(40);

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: SHA-1("<type> <size>\0" + bytes). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeObject(type: GitObjectType, data: Buffer): GitObject {
  return { type, data, deflated: null };
}

/** The object's zlib bytes, deflated once and reused by every pack. */
export function deflatedOf(obj: GitObject): Buffer {
  if (obj.deflated === null) obj.deflated = deflateSync(obj.data);
  return obj.deflated;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree order: a directory compares as if its name ended with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
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
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}): Buffer {
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) out += `parent ${parent}\n`;
  out += `author ${fields.author}\ncommitter ${fields.committer}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

/** "Name <email> <epoch> +0000", the identity line a commit carries. */
export function ident(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- deltas

function readDeltaSize(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = delta[i] ?? 0;
    i += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta instruction stream to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  const target = readDeltaSize(delta, source.next);
  if (source.value !== base.length) throw new Error('delta source size mismatch');
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let offset = target.next;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      if (written + copySize > target.value) throw new Error('delta writes past target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert truncated');
      if (written + literal > target.value) throw new Error('delta writes past target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error('delta size mismatch');
  return out;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_NAMES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export interface PackReadResult {
  /** Every object the pack carried, by oid (deltas resolved). */
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
 * leaves out (an object the repository already holds).
 */
export function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => GitObject | undefined = () => undefined,
): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  const checksumOk = trailer === computed;
  if (!checksumOk) throw new Error('pack checksum mismatch');

  interface RawEntry {
    readonly typeNum: number;
    readonly data: Buffer;
    readonly offset: number;
    readonly baseOid?: string;
    readonly baseOffset?: number;
  }
  const raw: RawEntry[] = [];
  let off = 12;
  for (let n = 0; n < declaredCount; n += 1) {
    const entryOffset = off;
    let byte = pack[off] ?? 0;
    off += 1;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off] ?? 0;
      off += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: the base is an offset back from this entry.
      let v = pack[off] ?? 0;
      off += 1;
      let value = v & 0x7f;
      while (v & 0x80) {
        v = pack[off] ?? 0;
        off += 1;
        value = ((value + 1) * 128) + (v & 0x7f);
      }
      baseOffset = entryOffset - value;
      if (baseOffset < 0) throw new Error('ofs-delta base offset is negative');
    } else if (typeNum === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (PACK_TYPE_NAMES[typeNum] === undefined) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    const inflated = inflateAt(pack, off);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    off = inflated.next;
    raw.push({ typeNum, data: inflated.data, offset: entryOffset, baseOid, baseOffset });
  }

  const objects = new Map<string, GitObject>();

  // Resolve in passes: a delta's base may be another entry in this pack
  // (by offset for OFS_DELTA, by oid for REF_DELTA) or an object the store
  // already holds (a thin pack). A pass with no progress means a cycle or a
  // missing base.
  const resolvedByOffset = new Map<number, GitObject>();
  let remaining = [...raw];
  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    const next: RawEntry[] = [];
    for (const entry of remaining) {
      const typeName = PACK_TYPE_NAMES[entry.typeNum];
      if (typeName !== undefined) {
        const obj = makeObject(typeName, entry.data);
        resolvedByOffset.set(entry.offset, obj);
        objects.set(hashObject(obj.type, obj.data), obj);
        progress = true;
        continue;
      }
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) {
        base = objects.get(entry.baseOid) ?? resolveBase(entry.baseOid);
      } else if (entry.baseOffset !== undefined) {
        base = resolvedByOffset.get(entry.baseOffset);
      }
      if (base === undefined) {
        next.push(entry);
        continue;
      }
      const obj = makeObject(base.type, applyDelta(base.data, entry.data));
      resolvedByOffset.set(entry.offset, obj);
      objects.set(hashObject(obj.type, obj.data), obj);
      progress = true;
    }
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('pack delta base could not be resolved');
  return { objects, checksumOk };
}

/** Encode one object's pack header (type + size varint). */
function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest !== 0) first |= 0x80;
  bytes.push(first);
  while (rest !== 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

const PACK_TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Write a plain packfile (version 2, no deltas) of whole objects, with the
 * SHA-1 trailer. The caller passes already-resolved objects.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packEntryHeader(PACK_TYPE_NUMBERS[obj.type], obj.data.length));
    parts.push(deflatedOf(obj));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: 4 lowercase hex digits of the total length, then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line over 65520 bytes');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktLinePacket =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Decode pkt-lines from a buffer, in order. Stops at `end` (default the
 * whole buffer) and reports how many bytes were consumed, so a caller can
 * find the raw packfile that follows a flush.
 */
export function decodePktLines(
  buffer: Buffer,
  end: number = buffer.length,
): { packets: PktLinePacket[]; consumed: number } {
  const packets: PktLinePacket[] = [];
  let off = 0;
  while (off < end) {
    if (off + 4 > end) throw new Error('pkt-line header truncated');
    const header = buffer.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`bad pkt-line length ${length}`);
    if (off + length > end) throw new Error('pkt-line truncated');
    packets.push({ kind: 'data', data: buffer.subarray(off + 4, off + length) });
    off += length;
  }
  return { packets, consumed: off };
}

/**
 * Decode pkt-lines only up to and including the first flush packet: the
 * receive-pack command section. The bytes after the flush are a raw
 * packfile, not pkt-lines, so decoding them would throw.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: PktLinePacket[]; consumed: number } {
  const packets: PktLinePacket[] = [];
  let off = 0;
  while (off < buffer.length) {
    if (off + 4 > buffer.length) throw new Error('pkt-line header truncated');
    const header = buffer.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`bad pkt-line length ${length}`);
    if (off + length > buffer.length) throw new Error('pkt-line truncated');
    packets.push({ kind: 'data', data: buffer.subarray(off + 4, off + length) });
    off += length;
  }
  return { packets, consumed: off };
}

/** The text lines of data packets, without their trailing newline. */
export function packetLines(packets: readonly PktLinePacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.data.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}
