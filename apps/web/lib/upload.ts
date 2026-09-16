/**
 * Resumable multipart upload client (FR-001). Media bytes go straight to signed URLs; only
 * control calls go through the API proxy. Progress is persisted after every part so a reload
 * can re-init the upload (the API returns `uploadedParts` for an active upload with the same
 * project + fileName + byteSize) and continue.
 */
import type {
  CompleteUploadRequestSchema,
  InitUploadRequest,
  InitUploadResponse,
  SignPartsResponse,
  UploadStatus,
} from '@polycast/contracts';
import type { z } from 'zod';
import { errorFromResponse } from './errors';

export type UploadPart = z.infer<typeof CompleteUploadRequestSchema>['parts'][number];

export interface UploadRecord {
  projectId: string;
  uploadId: string;
  assetId: string;
  fileName: string;
  byteSize: number;
  partSizeBytes: number;
  partCount: number;
  parts: UploadPart[];
  updatedAt: string;
}

export type UploadPhase =
  | 'idle'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'aborted'
  | 'failed';

export interface UploadProgress {
  phase: UploadPhase;
  uploadedParts: number;
  partCount: number;
  uploadedBytes: number;
  totalBytes: number;
  /** [0, 1] */
  fraction: number;
  error?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UploaderOptions {
  projectId: string;
  file: Blob;
  fileName: string;
  contentType: InitUploadRequest['contentType'];
  onProgress?: (p: UploadProgress) => void;
  /** Injection points for tests. */
  fetch?: typeof fetch;
  storage?: StorageLike | null;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  signBatchSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
  apiBase?: string;
}

export const uploadStorageKey = (projectId: string) => `pc.upload.${projectId}`;

export function readUploadRecord(
  storage: StorageLike | null,
  projectId: string,
): UploadRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(uploadStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UploadRecord;
    return parsed && typeof parsed.uploadId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearUploadRecord(storage: StorageLike | null, projectId: string): void {
  try {
    storage?.removeItem(uploadStorageKey(projectId));
  } catch {
    /* storage unavailable */
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UploadAbortedError extends Error {
  override readonly name = 'UploadAbortedError';
  constructor() {
    super('Upload aborted');
  }
}

interface SignedPart {
  url: string;
  expiresAt: number;
}

export class MultipartUploader {
  private readonly fetchImpl: typeof fetch;
  private readonly storage: StorageLike | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly concurrency: number;
  private readonly signBatchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly apiBase: string;

  private record: UploadRecord | null = null;
  private readonly uploaded = new Map<number, string>();
  private readonly signed = new Map<number, SignedPart>();
  private signing: Promise<void> | null = null;
  private queue: number[] = [];
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private aborted = false;
  private controller = new AbortController();
  private phase: UploadPhase = 'idle';

  constructor(private readonly opts: UploaderOptions) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.storage =
      opts.storage !== undefined
        ? opts.storage
        : typeof localStorage === 'undefined'
          ? null
          : localStorage;
    this.sleep = opts.sleep ?? defaultSleep;
    this.concurrency = opts.concurrency ?? 3;
    this.signBatchSize = opts.signBatchSize ?? 8;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.backoffMs = opts.backoffMs ?? 500;
    this.apiBase = opts.apiBase ?? '/api/v1';
  }

  get uploadId(): string | null {
    return this.record?.uploadId ?? null;
  }

  /** Runs init → parts → complete. Resolves with the completed UploadStatus. */
  async run(): Promise<UploadStatus> {
    this.setPhase('initializing');
    try {
      const init = await this.init();
      for (const p of init.uploadedParts) this.uploaded.set(p.partNumber, stripQuotes(p.etag));
      this.persist();
      this.queue = [];
      for (let n = 1; n <= init.partCount; n += 1) if (!this.uploaded.has(n)) this.queue.push(n);
      this.setPhase(this.paused ? 'paused' : 'uploading');
      const workers = Array.from({ length: Math.max(1, this.concurrency) }, () => this.worker());
      await Promise.all(workers);
      if (this.aborted) throw new UploadAbortedError();
      this.setPhase('completing');
      const status = await this.complete();
      clearUploadRecord(this.storage, this.opts.projectId);
      this.setPhase('completed');
      return status;
    } catch (e) {
      if (this.aborted || e instanceof UploadAbortedError) {
        this.setPhase('aborted');
        throw e instanceof UploadAbortedError ? e : new UploadAbortedError();
      }
      this.setPhase('failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  pause(): void {
    if (this.paused || this.phase === 'completed' || this.phase === 'aborted') return;
    this.paused = true;
    if (this.phase === 'uploading') this.setPhase('paused');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.phase === 'paused') this.setPhase('uploading');
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  /** Cancels in-flight parts, tells the API to abort, and forgets persisted progress. */
  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.controller.abort();
    this.resume();
    const id = this.record?.uploadId;
    clearUploadRecord(this.storage, this.opts.projectId);
    if (id) {
      await this.fetchImpl(`${this.apiBase}/uploads/${id}/abort`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    this.setPhase('aborted');
  }

  private async init(): Promise<InitUploadResponse> {
    const body: InitUploadRequest = {
      projectId: this.opts.projectId,
      fileName: this.opts.fileName,
      contentType: this.opts.contentType,
      byteSize: this.opts.file.size,
    };
    const res = await this.fetchImpl(`${this.apiBase}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    const init = (await res.json()) as InitUploadResponse;
    const previous = readUploadRecord(this.storage, this.opts.projectId);
    // Locally-known parts are only trusted when the server resumed the same upload id.
    const localParts =
      previous && previous.uploadId === init.uploadId ? previous.parts : ([] as UploadPart[]);
    for (const p of localParts) this.uploaded.set(p.partNumber, stripQuotes(p.etag));
    this.record = {
      projectId: this.opts.projectId,
      uploadId: init.uploadId,
      assetId: init.assetId,
      fileName: this.opts.fileName,
      byteSize: this.opts.file.size,
      partSizeBytes: init.partSizeBytes,
      partCount: init.partCount,
      parts: [],
      updatedAt: new Date().toISOString(),
    };
    return init;
  }

  private async worker(): Promise<void> {
    for (;;) {
      await this.gate();
      if (this.aborted) return;
      const partNumber = this.queue.shift();
      if (partNumber === undefined) return;
      await this.uploadPart(partNumber);
      if (this.aborted) return;
    }
  }

  private gate(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private async uploadPart(partNumber: number): Promise<void> {
    const record = this.record;
    if (!record) throw new Error('upload not initialised');
    const start = (partNumber - 1) * record.partSizeBytes;
    const end = Math.min(start + record.partSizeBytes, record.byteSize);
    const chunk = this.opts.file.slice(start, end);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.aborted) return;
      try {
        const { url } = await this.signedUrl(partNumber);
        const res = await this.fetchImpl(url, {
          method: 'PUT',
          body: chunk,
          signal: this.controller.signal,
        });
        if (!res.ok) throw new Error(`part ${partNumber} upload failed with HTTP ${res.status}`);
        const etag = res.headers.get('etag') ?? res.headers.get('ETag');
        if (!etag) throw new Error(`part ${partNumber} response carried no ETag`);
        this.uploaded.set(partNumber, stripQuotes(etag));
        this.persist();
        this.emit();
        return;
      } catch (e) {
        if (this.aborted) return;
        lastError = e;
        this.signed.delete(partNumber); // re-sign on retry: the URL may have expired
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs * 2 ** (attempt - 1));
          await this.gate();
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`part ${partNumber} failed after ${this.maxAttempts} attempts`);
  }

  /** Signs URLs in batches so 3 workers share one request per 8 parts. */
  private async signedUrl(partNumber: number): Promise<SignedPart> {
    const fresh = (p: SignedPart | undefined) =>
      p !== undefined && p.expiresAt > Date.now() + 5_000;
    if (fresh(this.signed.get(partNumber))) return this.signed.get(partNumber)!;
    if (this.signing) {
      await this.signing;
      if (fresh(this.signed.get(partNumber))) return this.signed.get(partNumber)!;
    }
    const batch = [partNumber];
    for (const n of this.queue) {
      if (batch.length >= this.signBatchSize) break;
      if (!fresh(this.signed.get(n)) && !batch.includes(n)) batch.push(n);
    }
    this.signing = this.signBatch(batch).finally(() => {
      this.signing = null;
    });
    await this.signing;
    const part = this.signed.get(partNumber);
    if (!part) throw new Error(`API did not sign part ${partNumber}`);
    return part;
  }

  private async signBatch(partNumbers: number[]): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/uploads/${this.record?.uploadId}/parts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ partNumbers }),
      signal: this.controller.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    const body = (await res.json()) as SignPartsResponse;
    for (const p of body.parts) {
      this.signed.set(p.partNumber, { url: p.url, expiresAt: Date.parse(p.expiresAt) || Infinity });
    }
  }

  private async complete(): Promise<UploadStatus> {
    const parts = this.sortedParts();
    const res = await this.fetchImpl(`${this.apiBase}/uploads/${this.record?.uploadId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ parts }),
    });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as UploadStatus;
  }

  private sortedParts(): UploadPart[] {
    return [...this.uploaded.entries()]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  private persist(): void {
    if (!this.record || !this.storage) return;
    this.record = {
      ...this.record,
      parts: this.sortedParts(),
      updatedAt: new Date().toISOString(),
    };
    try {
      this.storage.setItem(uploadStorageKey(this.opts.projectId), JSON.stringify(this.record));
    } catch {
      /* storage full or unavailable: resume will rely on the API's uploadedParts */
    }
  }

  private setPhase(phase: UploadPhase, error?: string): void {
    this.phase = phase;
    this.emit(error);
  }

  private emit(error?: string): void {
    const record = this.record;
    const partCount = record?.partCount ?? 0;
    const partSize = record?.partSizeBytes ?? 0;
    const total = this.opts.file.size;
    const uploadedBytes = Math.min(total, this.uploaded.size * partSize);
    this.opts.onProgress?.({
      phase: this.phase,
      uploadedParts: this.uploaded.size,
      partCount,
      uploadedBytes,
      totalBytes: total,
      fraction:
        this.phase === 'completed' ? 1 : partCount === 0 ? 0 : this.uploaded.size / partCount,
      ...(error !== undefined ? { error } : {}),
    });
  }
}

export function stripQuotes(etag: string): string {
  return etag
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
}
