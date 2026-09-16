import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ObjectInfo, SignedUrl, StorageDriver, UploadedPart } from './driver.js';

export interface LocalFsOptions {
  rootDir: string;
  /** Base URL of this API, used to build signed URLs. */
  publicBaseUrl: string;
  secret: string;
  ttlSeconds: number;
}

export interface LocalSignature {
  method: 'PUT' | 'GET';
  bucket: string;
  key: string;
  uploadId?: string;
  partNumber?: number;
  fileName?: string;
  expires: number;
}

/**
 * Filesystem driver. Objects live at `<root>/<bucket>/<key>`; multipart parts are staged at
 * `<root>/<bucket>/.multipart/<uploadId>/<n>` and concatenated on complete. Signed URLs point at
 * this API's `/local-storage/*` routes and carry an HMAC over (method, bucket, key, upload, part,
 * expires). Never used in production (config fails closed).
 */
export class LocalFsStorage implements StorageDriver {
  readonly scheme = 'local' as const;
  private readonly root: string;

  constructor(private readonly opts: LocalFsOptions) {
    this.root = resolve(opts.rootDir);
  }

  uri(bucket: string, key: string): string {
    return `local://${bucket}/${key}`;
  }

  objectPath(bucket: string, key: string): string {
    if (key.split('/').some((seg) => seg === '..' || seg === ''))
      throw new Error('key escapes storage root');
    const p = resolve(this.root, bucket, key);
    if (!p.startsWith(this.root + sep)) throw new Error('key escapes storage root');
    return p;
  }

  private partDir(bucket: string, uploadId: string): string {
    return this.objectPath(bucket, join('.multipart', uploadId));
  }

  sign(sig: LocalSignature): string {
    const payload = [
      sig.method,
      sig.bucket,
      sig.key,
      sig.uploadId ?? '',
      sig.partNumber ?? '',
      sig.fileName ?? '',
      sig.expires,
    ].join('\n');
    return createHmac('sha256', this.opts.secret).update(payload).digest('hex');
  }

  verify(sig: LocalSignature, signature: string, now = Date.now()): boolean {
    if (sig.expires * 1000 < now) return false;
    const expected = Buffer.from(this.sign(sig), 'hex');
    const given = Buffer.from(signature, 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private signedUrl(sig: LocalSignature): SignedUrl {
    const url = new URL(`/local-storage/${sig.bucket}/${sig.key}`, this.opts.publicBaseUrl);
    if (sig.uploadId) url.searchParams.set('uploadId', sig.uploadId);
    if (sig.partNumber !== undefined) url.searchParams.set('partNumber', String(sig.partNumber));
    if (sig.fileName) url.searchParams.set('fileName', sig.fileName);
    url.searchParams.set('expires', String(sig.expires));
    url.searchParams.set('signature', this.sign(sig));
    return { url: url.toString(), expiresAt: new Date(sig.expires * 1000).toISOString() };
  }

  private expiry(): number {
    return Math.floor(Date.now() / 1000) + this.opts.ttlSeconds;
  }

  async createMultipartUpload(bucket: string, _key: string, _contentType: string): Promise<string> {
    const uploadId = randomUUID();
    await mkdir(this.partDir(bucket, uploadId), { recursive: true });
    return uploadId;
  }

  async signPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<SignedUrl> {
    return this.signedUrl({
      method: 'PUT',
      bucket,
      key,
      uploadId,
      partNumber,
      expires: this.expiry(),
    });
  }

  /** Called by the PUT route after verifying the signature. Returns the ETag. */
  async writePart(
    bucket: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const dir = this.partDir(bucket, uploadId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${partNumber}.tmp`);
    await writeFile(tmp, body);
    await rename(tmp, join(dir, String(partNumber)));
    return `"${createHash('md5').update(body).digest('hex')}"`;
  }

  async listParts(bucket: string, _key: string, uploadId: string): Promise<UploadedPart[]> {
    const dir = this.partDir(bucket, uploadId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const parts: UploadedPart[] = [];
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      const buf = await readFile(join(dir, n));
      parts.push({
        partNumber: Number(n),
        etag: `"${createHash('md5').update(buf).digest('hex')}"`,
      });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    const dir = this.partDir(bucket, uploadId);
    const target = this.objectPath(bucket, key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${uploadId}`;
    const chunks: Buffer[] = [];
    for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const buf = await readFile(join(dir, String(p.partNumber)));
      const etag = `"${createHash('md5').update(buf).digest('hex')}"`;
      if (etag !== p.etag) throw new Error(`etag mismatch for part ${p.partNumber}`);
      chunks.push(buf);
    }
    await writeFile(tmp, Buffer.concat(chunks));
    await rename(tmp, target);
    await rm(dir, { recursive: true, force: true });
  }

  async abortMultipartUpload(bucket: string, _key: string, uploadId: string): Promise<void> {
    await rm(this.partDir(bucket, uploadId), { recursive: true, force: true });
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | string,
    _contentType: string,
  ): Promise<void> {
    const target = this.objectPath(bucket, key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    await writeFile(tmp, body);
    await rename(tmp, target);
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    return readFile(this.objectPath(bucket, key));
  }

  async headObject(bucket: string, key: string): Promise<ObjectInfo | null> {
    try {
      const s = await stat(this.objectPath(bucket, key));
      return { byteSize: s.size, contentType: null };
    } catch {
      return null;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await unlink(this.objectPath(bucket, key)).catch(() => undefined);
  }

  async signGetUrl(bucket: string, key: string, fileName: string): Promise<SignedUrl> {
    return this.signedUrl({ method: 'GET', bucket, key, fileName, expires: this.expiry() });
  }
}
