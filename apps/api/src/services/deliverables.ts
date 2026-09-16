import { NotFoundError } from '@polycast/domain';
import type { DeliverablesResponse, DownloadLinkResponse } from '@polycast/contracts';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../db/pool.js';
import type { StorageDriver } from '../storage/index.js';
import { parseStorageUri } from '../storage/index.js';
import {
  OPEN_ISSUES_SQL,
  deliverableView,
  targetView,
  type DeliverableRow,
  type TargetRow,
} from './views.js';

export class DeliverableService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
  ) {}

  async list(p: Principal, targetJobId: string): Promise<DeliverablesResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const target = (
          await tx.query<TargetRow>(
            `SELECT t.*, ${OPEN_ISSUES_SQL} FROM target_jobs t WHERE t.id = $1`,
            [targetJobId],
          )
        ).rows[0];
        if (!target) throw new NotFoundError('TargetJob', targetJobId);
        const rows = (
          await tx.query<DeliverableRow>(
            'SELECT * FROM deliverables WHERE target_job_id = $1 AND package_version = $2 AND ready ORDER BY kind, file_name',
            [targetJobId, target.package_version],
          )
        ).rows;
        return {
          target: targetView(target),
          packageVersion: target.package_version,
          deliverables: rows.map(deliverableView),
        };
      },
    );
  }

  /** Mints a short-lived link and records the access (FR-061). */
  async downloadLink(
    p: Principal,
    targetJobId: string,
    deliverableId: string,
    correlationId: string,
    ip: string,
  ): Promise<DownloadLinkResponse> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const row = (
          await tx.query<DeliverableRow>(
            'SELECT * FROM deliverables WHERE id = $1 AND target_job_id = $2',
            [deliverableId, targetJobId],
          )
        ).rows[0];
        if (!row) throw new NotFoundError('Deliverable', deliverableId);
        const { bucket, key } = parseStorageUri(row.storage_uri);
        const signed = await this.storage.signGetUrl(bucket, key, row.file_name);
        await recordAudit(tx, {
          organizationId: p.organizationId,
          actorUserId: p.userId,
          action: 'deliverable.downloaded',
          objectType: 'Deliverable',
          objectId: row.id,
          correlationId,
          ipAddress: ip,
        });
        return {
          url: signed.url,
          expiresAt: signed.expiresAt,
          fileName: row.file_name,
          sha256: row.sha256,
        };
      },
    );
  }

  async manifest(p: Principal, targetJobId: string): Promise<unknown | null> {
    return this.db.withTenant(
      { organizationId: p.organizationId, userId: p.userId },
      async (tx) => {
        const row = (
          await tx.query<{ manifest: unknown }>(
            'SELECT manifest FROM provenance_manifests WHERE target_job_id = $1 ORDER BY package_version DESC LIMIT 1',
            [targetJobId],
          )
        ).rows[0];
        return row?.manifest ?? null;
      },
    );
  }
}
