import { describe, expect, it, vi } from 'vitest';
import {
  MultipartUploader,
  readUploadRecord,
  stripQuotes,
  uploadStorageKey,
  type StorageLike,
  type UploadProgress,
} from './upload';

const PROJECT = '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e6f';
const UPLOAD = '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e70';
const ASSET = '018f4d1c-0d8e-7c3b-8c8e-1a2b3c4d5e71';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface Harness {
  fetch: ReturnType<typeof vi.fn>;
  puts: Array<{ url: string; size: number }>;
  signRequests: number[][];
  completeBody: () => unknown;
}

/** Fake API + S3: 4 parts of 4 bytes over a 16-byte file. */
function harness(
  opts: {
    uploadedParts?: Array<{ partNumber: number; etag: string }>;
    failPut?: (url: string, attempt: number) => boolean;
  } = {},
): Harness {
  const puts: Harness['puts'] = [];
  const signRequests: number[][] = [];
  const putAttempts = new Map<string, number>();
  let completeBody: unknown = null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/uploads' && method === 'POST') {
      return json({
        uploadId: UPLOAD,
        assetId: ASSET,
        partSizeBytes: 4,
        partCount: 4,
        uploadedParts: opts.uploadedParts ?? [],
      });
    }
    if (url === `/api/v1/uploads/${UPLOAD}/parts`) {
      const { partNumbers } = JSON.parse(String(init?.body)) as { partNumbers: number[] };
      signRequests.push(partNumbers);
      return json({
        parts: partNumbers.map((n) => ({
          partNumber: n,
          url: `https://s3.local/part/${n}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })),
      });
    }
    if (url === `/api/v1/uploads/${UPLOAD}/complete`) {
      completeBody = JSON.parse(String(init?.body));
      return json({
        uploadId: UPLOAD,
        assetId: ASSET,
        projectId: PROJECT,
        status: 'completed',
        assetStatus: 'QUARANTINED',
        partSizeBytes: 4,
        partCount: 4,
        byteSize: 16,
        uploadedParts: [],
      });
    }
    if (url.startsWith('https://s3.local/part/') && method === 'PUT') {
      const attempt = (putAttempts.get(url) ?? 0) + 1;
      putAttempts.set(url, attempt);
      if (opts.failPut?.(url, attempt)) return new Response(null, { status: 503 });
      const body = init?.body as Blob;
      puts.push({ url, size: body.size });
      return new Response(null, {
        status: 200,
        headers: { ETag: `"etag-${url.split('/').pop()}"` },
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  return { fetch: fetchMock, puts, signRequests, completeBody: () => completeBody };
}

const file = () => new Blob([new Uint8Array(16).map((_, i) => i)]);

describe('MultipartUploader', () => {
  it('uploads every part, strips ETag quotes, and completes with sorted parts', async () => {
    const h = harness();
    const storage = memoryStorage();
    const progress: UploadProgress[] = [];
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage,
      sleep: async () => {},
      onProgress: (p) => progress.push(p),
    });
    const status = await up.run();
    expect(status.status).toBe('completed');
    expect(h.puts).toHaveLength(4);
    expect(h.puts.every((p) => p.size === 4)).toBe(true);
    expect(h.completeBody()).toEqual({
      parts: [1, 2, 3, 4].map((n) => ({ partNumber: n, etag: `etag-${n}` })),
    });
    // one batched sign request for all four parts
    expect(h.signRequests).toEqual([[1, 2, 3, 4]]);
    expect(progress.at(-1)?.phase).toBe('completed');
    expect(progress.at(-1)?.fraction).toBe(1);
    // progress cleared after completion
    expect(storage.data.has(uploadStorageKey(PROJECT))).toBe(false);
  });

  it('resumes by skipping parts the API already has', async () => {
    const h = harness({
      uploadedParts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage: memoryStorage(),
      sleep: async () => {},
    });
    await up.run();
    expect(h.puts.map((p) => p.url)).toEqual([
      'https://s3.local/part/2',
      'https://s3.local/part/4',
    ]);
    expect(h.signRequests).toEqual([[2, 4]]);
    expect(h.completeBody()).toEqual({
      parts: [1, 2, 3, 4].map((n) => ({ partNumber: n, etag: `etag-${n}` })),
    });
  });

  it('retries a failing PUT with backoff and re-signs the part', async () => {
    const h = harness({ failPut: (url, attempt) => url.endsWith('/2') && attempt < 3 });
    const sleep = vi.fn(async (ms: number) => {
      void ms;
    });
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage: memoryStorage(),
      sleep,
      backoffMs: 10,
      concurrency: 1,
    });
    await up.run();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
    expect(h.puts.map((p) => p.url)).toEqual([1, 2, 3, 4].map((n) => `https://s3.local/part/${n}`));
    // part 2 was re-signed twice after failures
    expect(h.signRequests.filter((r) => r.includes(2)).length).toBe(3);
  });

  it('gives up after maxAttempts and reports failure', async () => {
    const h = harness({ failPut: (url) => url.endsWith('/1') });
    const progress: UploadProgress[] = [];
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage: memoryStorage(),
      sleep: async () => {},
      maxAttempts: 2,
      onProgress: (p) => progress.push(p),
    });
    await expect(up.run()).rejects.toThrow(/HTTP 503/);
    expect(progress.at(-1)?.phase).toBe('failed');
  });

  it('persists progress after each part so a reload can resume', async () => {
    const h = harness();
    const storage = memoryStorage();
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage,
      sleep: async () => {},
      concurrency: 1,
    });
    let seen = 0;
    const original = storage.setItem;
    storage.setItem = (k, v) => {
      seen += 1;
      original(k, v);
    };
    await up.run();
    // init + 4 parts
    expect(seen).toBe(5);
    expect(readUploadRecord(storage, PROJECT)).toBeNull();
  });

  it('pauses and resumes', async () => {
    const h = harness();
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage: memoryStorage(),
      sleep: async () => {},
      concurrency: 1,
    });
    up.pause();
    const run = up.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.puts).toHaveLength(0);
    up.resume();
    await run;
    expect(h.puts).toHaveLength(4);
  });

  it('abort stops work, calls the API, and clears storage', async () => {
    const h = harness();
    const storage = memoryStorage();
    const up = new MultipartUploader({
      projectId: PROJECT,
      file: file(),
      fileName: 'ep.mp4',
      contentType: 'video/mp4',
      fetch: h.fetch as unknown as typeof fetch,
      storage,
      sleep: async () => {},
      concurrency: 1,
    });
    up.pause();
    const run = up.run();
    await new Promise((r) => setTimeout(r, 10));
    await up.abort();
    await expect(run).rejects.toThrow(/aborted/);
    expect(h.fetch).toHaveBeenCalledWith(`/api/v1/uploads/${UPLOAD}/abort`, { method: 'POST' });
    expect(storage.data.size).toBe(0);
  });
});

describe('stripQuotes', () => {
  it('handles quoted, weak and bare etags', () => {
    expect(stripQuotes('"abc"')).toBe('abc');
    expect(stripQuotes('W/"abc"')).toBe('abc');
    expect(stripQuotes('abc')).toBe('abc');
  });
});
