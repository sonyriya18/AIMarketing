/**
 * Private object storage. Keys are generated server-side (never user-supplied paths) and
 * live outside the web root. The filesystem driver writes atomically (temp file + rename).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface StoredObject {
  key: string;
  sha256: string;
  byteSize: number;
}

export interface ObjectStorage {
  put(workspaceId: string, kind: string, bytes: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  healthy(): Promise<boolean>;
}

const KEY_RE = /^[0-9a-f-]{36}\/[a-z_]{1,32}\/[0-9a-f-]{36}$/;

export class FilesystemStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(workspaceId: string, kind: string, bytes: Buffer): Promise<StoredObject> {
    const key = `${workspaceId}/${kind}/${randomUUID()}`;
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, target);
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async healthy(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return (await stat(this.root)).isDirectory();
    } catch {
      return false;
    }
  }
}

/** The subset of a Netlify Blobs store used here (lets tests supply an in-memory store). */
export interface BlobStoreLike {
  set(key: string, data: ArrayBuffer): Promise<unknown>;
  get(key: string, options: { type: 'arrayBuffer'; consistency?: 'strong' | 'eventual' }): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

/** Netlify Blobs driver: same generated-key scheme; objects are private to the site. */
export class BlobStorage implements ObjectStorage {
  constructor(private readonly store: BlobStoreLike) {}

  private check(key: string) {
    if (!KEY_RE.test(key)) throw new Error('Invalid storage key');
    return key;
  }

  async put(workspaceId: string, kind: string, bytes: Buffer): Promise<StoredObject> {
    const key = this.check(`${workspaceId}/${kind}/${randomUUID()}`);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.store.set(key, copy);
    return { key, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    const data = await this.store.get(this.check(key), { type: 'arrayBuffer', consistency: 'strong' });
    if (!data) throw new Error('Stored object not found');
    return Buffer.from(data);
  }

  async remove(key: string): Promise<void> {
    await this.store.delete(this.check(key));
  }

  async healthy(): Promise<boolean> {
    try {
      await this.store.get('health/probe', { type: 'arrayBuffer' });
      return true;
    } catch {
      return false;
    }
  }
}
