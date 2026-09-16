import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFsStorage } from '../src/storage/local-fs.js';
import { S3Storage } from '../src/storage/s3.js';
import { parseStorageUri, tenantKey } from '../src/storage/driver.js';

describe('storage keys and uris', () => {
  test('tenantKey always starts with the organization id and sanitises parts', () => {
    expect(tenantKey('org', 'proj', 'a b/../c', 'file name.mp4')).toBe(
      'org/proj/a_b/c/file_name.mp4',
    );
    expect(tenantKey('org', '../other', 'x')).toBe('org/other/x');
    expect(parseStorageUri('s3://polycast-source/org/k.wav')).toEqual({
      scheme: 's3',
      bucket: 'polycast-source',
      key: 'org/k.wav',
    });
    expect(() => parseStorageUri('http://x/y')).toThrow();
  });
});

describe('LocalFsStorage', () => {
  const storage = new LocalFsStorage({
    rootDir: mkdtempSync(join(tmpdir(), 'pc-storage-')),
    publicBaseUrl: 'http://127.0.0.1:4000',
    secret: 'unit-secret',
    ttlSeconds: 60,
  });

  test('multipart upload assembles parts in order and verifies etags', async () => {
    const uploadId = await storage.createMultipartUpload(
      'b',
      'org/k.bin',
      'application/octet-stream',
    );
    const e2 = await storage.writePart('b', uploadId, 2, Buffer.from('world'));
    const e1 = await storage.writePart('b', uploadId, 1, Buffer.from('hello '));
    expect(await storage.listParts('b', 'org/k.bin', uploadId)).toEqual([
      { partNumber: 1, etag: e1 },
      { partNumber: 2, etag: e2 },
    ]);
    await expect(
      storage.completeMultipartUpload('b', 'org/k.bin', uploadId, [
        { partNumber: 1, etag: e1 },
        { partNumber: 2, etag: '"bad"' },
      ]),
    ).rejects.toThrow(/etag/);
    await storage.completeMultipartUpload('b', 'org/k.bin', uploadId, [
      { partNumber: 2, etag: e2 },
      { partNumber: 1, etag: e1 },
    ]);
    expect((await storage.getObject('b', 'org/k.bin')).toString()).toBe('hello world');
    expect(await storage.listParts('b', 'org/k.bin', uploadId)).toEqual([]);
  });

  test('signed urls expire and reject tampering', async () => {
    const signed = await storage.signGetUrl('b', 'org/k.bin', 'k.bin');
    const url = new URL(signed.url);
    const sig = {
      method: 'GET' as const,
      bucket: 'b',
      key: 'org/k.bin',
      fileName: 'k.bin',
      expires: Number(url.searchParams.get('expires')),
    };
    expect(storage.verify(sig, url.searchParams.get('signature') as string)).toBe(true);
    expect(
      storage.verify({ ...sig, key: 'org/other.bin' }, url.searchParams.get('signature') as string),
    ).toBe(false);
    expect(
      storage.verify({ ...sig, method: 'PUT' }, url.searchParams.get('signature') as string),
    ).toBe(false);
    expect(
      storage.verify(sig, url.searchParams.get('signature') as string, (sig.expires + 1) * 1000),
    ).toBe(false);
    expect(storage.verify(sig, 'deadbeef')).toBe(false);
  });

  test('keys cannot escape the storage root', () => {
    expect(() => storage.objectPath('b', '../../etc/passwd')).toThrow(/escapes/);
    expect(() => storage.objectPath('b', 'org/../other/file')).toThrow(/escapes/);
  });
});

describe('S3Storage', () => {
  test('presigned urls are path-style against the configured endpoint and never exceed 15 minutes', async () => {
    const s3 = new S3Storage({
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      forcePathStyle: true,
      ttlSeconds: 900,
    });
    const part = await s3.signPartUrl('polycast-quarantine', 'org/p/a/file.mp4', 'upload-1', 3);
    const u = new URL(part.url);
    expect(u.origin).toBe('http://localhost:9000');
    expect(u.pathname).toBe('/polycast-quarantine/org/p/a/file.mp4');
    expect(u.searchParams.get('partNumber')).toBe('3');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(new Date(part.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(900_000);
    const get = await s3.signGetUrl(
      'polycast-deliverables',
      'org/t/v1/episode.mp3',
      'episode "1".mp3',
    );
    expect(new URL(get.url).searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="episode 1.mp3"',
    );
  });
});
