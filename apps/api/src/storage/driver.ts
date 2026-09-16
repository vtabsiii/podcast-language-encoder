/**
 * Object storage port. Two drivers: `s3` (MinIO locally, S3 in AWS) and `local` (filesystem,
 * signed URLs served by this API). Both expose the same multipart semantics so the upload flow
 * (FR-001) is identical everywhere. URIs are `s3://bucket/key` or `local://bucket/key`.
 */
export interface StorageUri {
  readonly scheme: 's3' | 'local';
  readonly bucket: string;
  readonly key: string;
}

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: string;
}

export interface ObjectInfo {
  readonly byteSize: number;
  readonly contentType: string | null;
}

export interface StorageDriver {
  readonly scheme: 's3' | 'local';
  uri(bucket: string, key: string): string;
  createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string>;
  signPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<SignedUrl>;
  listParts(bucket: string, key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void>;
  abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void>;
  putObject(bucket: string, key: string, body: Buffer | string, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  headObject(bucket: string, key: string): Promise<ObjectInfo | null>;
  deleteObject(bucket: string, key: string): Promise<void>;
  /** Short-lived GET link (≤ 15 min) with a download file name. */
  signGetUrl(bucket: string, key: string, fileName: string): Promise<SignedUrl>;
}

export function parseStorageUri(uri: string): StorageUri {
  const m = /^(s3|local):\/\/([a-z0-9.-]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error('invalid storage uri');
  return { scheme: m[1] as 's3' | 'local', bucket: m[2] as string, key: m[3] as string };
}

/**
 * Keys are always tenant-prefixed (NFR-002). Dot segments are dropped so a caller-supplied part
 * can never traverse out of the organization's prefix on any driver.
 */
export function tenantKey(organizationId: string, ...parts: string[]): string {
  const safe = parts.flatMap((p) =>
    p
      .replace(/[^A-Za-z0-9._/-]/g, '_')
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..'),
  );
  return [organizationId, ...safe].join('/');
}
