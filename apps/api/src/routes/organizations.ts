import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  CreateOrganizationRequestSchema,
  CreateOrganizationResponseSchema,
  ErrorEnvelopeSchema,
} from '@polycast/contracts';
import { uuidv7, type Role } from '@polycast/domain';
import { recordAudit } from '../audit.js';
import { identityOf, requireIdentity } from '../auth/principal.js';
import type { Db } from '../db/pool.js';
import { ORG_COLUMNS, orgView, type OrgRow } from './views.js';

export interface OrganizationRouteOptions {
  db: Db;
}

/**
 * Self-service organization creation (any valid identity, membership not required). This is
 * the only path by which a freshly signed-in production user obtains their first membership;
 * the caller becomes the organization's owner and the creation is audited.
 */
export const organizationRoutes: FastifyPluginAsyncZod<OrganizationRouteOptions> = async (
  app,
  opts,
) => {
  app.post(
    '/organizations',
    {
      preHandler: requireIdentity,
      schema: {
        tags: ['organizations'],
        summary: 'Create an organization and become its owner',
        body: CreateOrganizationRequestSchema,
        response: {
          201: CreateOrganizationResponseSchema,
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const identity = identityOf(req);
      const role: Role = 'owner';
      const org = await opts.db.withSystem(async (tx) => {
        await tx.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
        const orgId = uuidv7();
        const created = (
          await tx.query<OrgRow>(
            `INSERT INTO organizations (id, name) VALUES ($1,$2) RETURNING ${ORG_COLUMNS}`,
            [orgId, req.body.name],
          )
        ).rows[0] as OrgRow;
        await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        await tx.query(
          'INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1,$2,$3,$4)',
          [uuidv7(), orgId, identity.userId, role],
        );
        await recordAudit(tx, {
          organizationId: orgId,
          actorUserId: identity.userId,
          action: 'organization.created',
          objectType: 'Organization',
          objectId: orgId,
          after: { name: req.body.name },
          correlationId: req.id,
          ipAddress: req.ip,
        });
        return created;
      });
      return reply.status(201).send({ organization: orgView(org), role });
    },
  );
};
