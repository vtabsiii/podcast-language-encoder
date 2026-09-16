import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectInfo, SignedUrl, StorageDriver, UploadedPart } from './driver.js';

export interface S3Options {
  region: string;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle: boolean;
  ttlSeconds: number;
}

/** MinIO locally (docker-compose), S3 in AWS. Presigned URLs never exceed 15 minutes. */
export class S3Storage implements StorageDriver {
  readonly scheme = 's3' as const;
  readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle,
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
    });
  }

  uri(bucket: string, key: string): string {
    return `s3://${bucket}/${key}`;
  }

  private expiresAt(): string {
    return new Date(Date.now() + this.opts.ttlSeconds * 1000).toISOString();
  }

  async createMultipartUpload(bucket: string, key: string, contentType: string): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error('S3 did not return an UploadId');
    return res.UploadId;
  }

  async signPartUrl(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.opts.ttlSeconds },
    );
    return { url, expiresAt: this.expiresAt() };
  }

  async listParts(bucket: string, key: string, uploadId: string): Promise<UploadedPart[]> {
    const res = await this.client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
    return (res.Parts ?? [])
      .filter((p) => p.PartNumber !== undefined && p.ETag !== undefined)
      .map((p) => ({ partNumber: p.PartNumber as number, etag: p.ETag as string }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error('empty object body');
    return Buffer.from(bytes);
  }

  async headObject(bucket: string, key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { byteSize: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async signGetUrl(bucket: string, key: string, fileName: string): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\r\n]/g, '')}"`,
      }),
      { expiresIn: this.opts.ttlSeconds },
    );
    return { url, expiresAt: this.expiresAt() };
  }
}
