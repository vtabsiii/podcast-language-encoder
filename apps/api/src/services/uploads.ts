import {
  DEFAULT_QUOTAS,
  DomainError,
  NotFoundError,
  assertSourceSize,
  partCount,
  uuidv7,
} from '@polycast/domain';
import type {
  InitUploadRequest,
  InitUploadResponse,
  SignPartsResponse,
  UploadStatus,
} from '@polycast/contracts';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/principal.js';
import type { Db, Queryable } from '../db/pool.js';
import { emitEvent } from '../events/outbox.js';
import type { LocalOrchestrator } from '../orchestrator/local.js';
import type { Buckets, StorageDriver } from '../storage/index.js';
import { tenantKey } from '../storage/index.js';
import type { AssetRow } from './views.js';

interface UploadRow {
  id: string;
  project_id: string;
  asset_id: string;
  bucket: string;
  object_key: string;
  provider_upload_id: string;
  part_size_bytes: number;
  part_count: number;
  byte_size: number;
  file_name: string;
  status: 'active' | 'completed' | 'aborted';
  parts: { partNumber: number; etag: string }[];
}

/**
 * Resumable multipart upload (FR-001). The API only mints signed part URLs and completes the
 * upload; bytes go straight to storage. Re-initialising for the same project/file/size resumes.
 */
export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly buckets: Buckets,
    private readonly orchestrator: LocalOrchestrator,
  ) {}

  async init(
    p: Principal,
    input: InitUploadRequest,
    correlationId: string,
    ip: string,
  ): Promise<InitUploadResponse> {
    assertSourceSize(input.byteSize);
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const project = (
          await tx.query<{ id: string; state: string }>(
            'SELECT id, state FROM projects WHERE id = $1 FOR UPDATE',
            [input.projectId],
          )
        ).rows[0];
        if (!project) throw new NotFoundError('Project', input.projectId);

        const existing = (
          await tx.query<UploadRow>(
            `SELECT * FROM uploads WHERE project_id = $1 AND file_name = $2 AND byte_size = $3 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
            [input.projectId, input.fileName, input.byteSize],
          )
        ).rows[0];
        if (existing) {
          const parts = await this.storage.listParts(
            existing.bucket,
            existing.object_key,
            existing.provider_upload_id,
          );
          return {
            uploadId: existing.id,
            assetId: existing.asset_id,
            partSizeBytes: existing.part_size_bytes,
            partCount: existing.part_count,
            uploadedParts: parts,
          };
        }

        const assetId = uuidv7();
        const key = tenantKey(p.organizationId, input.projectId, assetId, input.fileName);
        const providerUploadId = await this.storage.createMultipartUpload(
          this.buckets.quarantine,
          key,
          input.contentType,
        );
        const uploadId = uuidv7();
        const partSize = DEFAULT_QUOTAS.uploadPartSizeBytes;
        const count = partCount(input.byteSize, partSize);
        await tx.query(
          `INSERT INTO assets (id, organization_id, project_id, kind, status, storage_uri, file_name, content_type, byte_size)
         VALUES ($1,$2,$3,'source','UPLOADING',$4,$5,$6,$7)`,
          [
            assetId,
            p.organizationId,
            input.projectId,
            this.storage.uri(this.buckets.quarantine, key),
            input.fileName,
            input.contentType,
            input.byteSize,
          ],
        );
        await tx.query(
          `INSERT INTO uploads (id, organization_id, project_id, asset_id, bucket, object_key, provider_upload_id, part_size_bytes, part_count, byte_size, file_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            uploadId,
            p.organizationId,
            input.projectId,
            assetId,
            this.buckets.quarantine,
            key,
            providerUploadId,
            partSize,
            count,
            input.byteSize,
            input.fileName,
          ],
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'upload.initiated',
          objectType: 'Asset',
          objectId: assetId,
          after: {
            fileName: input.fileName,
            byteSize: input.byteSize,
            contentType: input.contentType,
          },
          correlationId,
          ipAddress: ip,
        });
        return { uploadId, assetId, partSizeBytes: partSize, partCount: count, uploadedParts: [] };
      },
    );
  }

  private async load(tx: Queryable, uploadId: string, lock = false): Promise<UploadRow> {
    const row = (
      await tx.query<UploadRow>(`SELECT * FROM uploads WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [
        uploadId,
      ])
    ).rows[0];
    if (!row) throw new NotFoundError('Upload', uploadId);
    return row;
  }

  private async statusOf(tx: Queryable, u: UploadRow): Promise<UploadStatus> {
    const asset = (await tx.query<AssetRow>('SELECT * FROM assets WHERE id = $1', [u.asset_id]))
      .rows[0];
    if (!asset) throw new NotFoundError('Asset', u.asset_id);
    const parts =
      u.status === 'active'
        ? await this.storage.listParts(u.bucket, u.object_key, u.provider_upload_id)
        : u.parts;
    return {
      uploadId: u.id,
      assetId: u.asset_id,
      projectId: u.project_id,
      status: u.status,
      assetStatus: asset.status,
      partSizeBytes: u.part_size_bytes,
      partCount: u.part_count,
      byteSize: Number(u.byte_size),
      uploadedParts: parts,
    };
  }

  async status(p: Principal, uploadId: string): Promise<UploadStatus> {
    return this.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, async (tx) =>
      this.statusOf(tx, await this.load(tx, uploadId)),
    );
  }

  async signParts(
    p: Principal,
    uploadId: string,
    partNumbers: number[],
  ): Promise<SignPartsResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const u = await this.load(tx, uploadId);
        if (u.status !== 'active') throw new DomainError('CONFLICT', `Upload is ${u.status}`);
        const bad = partNumbers.find((n) => n < 1 || n > u.part_count);
        if (bad !== undefined) {
          throw new DomainError('VALIDATION_FAILED', 'Part number out of range', {
            fieldErrors: [{ path: 'partNumbers', message: `1..${u.part_count}` }],
          });
        }
        const parts = await Promise.all(
          partNumbers.map(async (n) => ({
            partNumber: n,
            ...(await this.storage.signPartUrl(u.bucket, u.object_key, u.provider_upload_id, n)),
          })),
        );
        return { parts };
      },
    );
  }

  async complete(
    p: Principal,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
    correlationId: string,
    ip: string,
  ): Promise<UploadStatus> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const u = await this.load(tx, uploadId, true);
        if (u.status === 'completed') return this.statusOf(tx, u);
        if (u.status !== 'active') throw new DomainError('CONFLICT', `Upload is ${u.status}`);
        const numbers = new Set(parts.map((x) => x.partNumber));
        if (numbers.size !== u.part_count) {
          throw new DomainError(
            'VALIDATION_FAILED',
            `Expected ${u.part_count} parts, received ${numbers.size}`,
            {
              fieldErrors: [{ path: 'parts', message: 'incomplete' }],
            },
          );
        }
        try {
          await this.storage.completeMultipartUpload(
            u.bucket,
            u.object_key,
            u.provider_upload_id,
            parts,
          );
        } catch (err) {
          if (err instanceof Error && /etag|part/i.test(err.message)) {
            throw new DomainError(
              'VALIDATION_FAILED',
              'One or more uploaded parts do not match; re-upload them and complete again',
              {
                fieldErrors: [{ path: 'parts', message: err.message }],
                cause: err,
              },
            );
          }
          throw err;
        }
        const head = await this.storage.headObject(u.bucket, u.object_key);
        if (!head || head.byteSize !== Number(u.byte_size)) {
          throw new DomainError(
            'VALIDATION_FAILED',
            'Uploaded size does not match the declared size',
            { fieldErrors: [{ path: 'byteSize', message: 'mismatch' }] },
          );
        }
        await tx.query(`UPDATE uploads SET status = 'completed', parts = $2 WHERE id = $1`, [
          u.id,
          JSON.stringify(parts),
        ]);
        const asset = (
          await tx.query<AssetRow>('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [u.asset_id])
        ).rows[0] as AssetRow;
        const ctx = { organizationId: p.organizationId, correlationId };
        // UPLOADING → QUARANTINED, then the orchestrator queues validation.
        await tx.query("UPDATE assets SET status = 'QUARANTINED' WHERE id = $1", [asset.id]);
        await emitEvent(tx, {
          name: 'upload.completed',
          organizationId: p.organizationId,
          correlationId,
          subject: { type: 'Asset', id: asset.id },
          projectId: asset.project_id,
          payload: {
            projectId: asset.project_id,
            assetId: asset.id,
            status: 'QUARANTINED',
            reason: null,
          },
        });
        await this.orchestrator.startAssetPipeline(
          tx,
          ctx,
          { ...asset, status: 'QUARANTINED' },
          DEFAULT_QUOTAS.maxSourceDurationUs,
        );
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'upload.completed',
          objectType: 'Asset',
          objectId: asset.id,
          correlationId,
          ipAddress: ip,
        });
        return this.statusOf(tx, { ...u, status: 'completed', parts });
      },
    );
  }

  async abort(
    p: Principal,
    uploadId: string,
    correlationId: string,
    ip: string,
  ): Promise<UploadStatus> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const u = await this.load(tx, uploadId, true);
        if (u.status === 'active') {
          await this.storage.abortMultipartUpload(u.bucket, u.object_key, u.provider_upload_id);
          await tx.query(`UPDATE uploads SET status = 'aborted' WHERE id = $1`, [u.id]);
          await tx.query(
            `UPDATE assets SET status = 'CANCELLED' WHERE id = $1 AND status = 'UPLOADING'`,
            [u.asset_id],
          );
          await recordAudit(tx, {
            organizationId: p.organizationId,
            actorUserId: p.userId,
            action: 'upload.aborted',
            objectType: 'Asset',
            objectId: u.asset_id,
            correlationId,
            ipAddress: ip,
          });
        }
        return this.statusOf(tx, { ...u, status: 'aborted' });
      },
    );
  }
}
