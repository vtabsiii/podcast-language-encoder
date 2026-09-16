import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DevLoginRequestSchema,
  DevLoginResponseSchema,
  ErrorEnvelopeSchema,
  MeResponseSchema,
} from '@polycast/contracts';
import { DomainError, ROLE_PERMISSIONS, uuidv7, type Role } from '@polycast/domain';
import { recordAudit } from '../audit.js';
import { signToken } from '../auth/jwt.js';
import { principalOf, requireAuth } from '../auth/principal.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { ORG_COLUMNS, orgView, userView, type OrgRow, type UserRow } from './views.js';

export interface AuthRouteOptions {
  config: AppConfig;
  db: Db;
}

/**
 * /auth/dev-login (local mode only) and /me. The dev login provisions the user and, when asked,
 * an organization with an owner membership, then issues a Cognito-shaped token (A-14).
 */
export const authRoutes: FastifyPluginAsyncZod<AuthRouteOptions> = async (app, opts) => {
  if (opts.config.AUTH_MODE === 'local' && opts.config.NODE_ENV !== 'production') {
    app.post(
      '/auth/dev-login',
      {
        schema: {
          tags: ['auth'],
          summary: 'Local sign-in (never enabled in production)',
          body: DevLoginRequestSchema,
          response: {
            200: DevLoginResponseSchema,
            400: ErrorEnvelopeSchema,
            403: ErrorEnvelopeSchema,
          },
        },
      },
      async (req) => {
        const body = req.body;
        const identitySubject = `local:${body.email.toLowerCase()}`;
        const result = await opts.db.withSystem(async (tx) => {
          let user = (
            await tx.query<UserRow>(
              'SELECT id, email, display_name, created_at FROM users WHERE identity_subject = $1',
              [identitySubject],
            )
          ).rows[0];
          if (!user) {
            const id = uuidv7();
            user = (
              await tx.query<UserRow>(
                'INSERT INTO users (id, email, display_name, identity_subject) VALUES ($1,$2,$3,$4) RETURNING id, email, display_name, created_at',
                [
                  id,
                  body.email.toLowerCase(),
                  body.displayName ?? body.email.split('@')[0] ?? 'user',
                  identitySubject,
                ],
              )
            ).rows[0] as UserRow;
          }
          await tx.query("SELECT set_config('app.user_id', $1, true)", [user.id]);

          let org: OrgRow | undefined;
          let role: Role;
          if (body.organizationName) {
            const orgId = uuidv7();
            org = (
              await tx.query<OrgRow>(
                `INSERT INTO organizations (id, name) VALUES ($1,$2) RETURNING ${ORG_COLUMNS}`,
                [orgId, body.organizationName],
              )
            ).rows[0];
            role = body.role ?? 'owner';
            await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
            await tx.query(
              'INSERT INTO memberships (id, organization_id, user_id, role) VALUES ($1,$2,$3,$4)',
              [uuidv7(), orgId, user.id, role],
            );
            await recordAudit(tx, {
              organizationId: orgId,
              actorUserId: user.id,
              action: 'organization.created',
              objectType: 'Organization',
              objectId: orgId,
              after: { name: body.organizationName },
              correlationId: req.id,
              ipAddress: req.ip,
            });
          } else {
            const memberships = (
              await tx.query<{ organization_id: string; role: Role }>(
                'SELECT organization_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at',
                [user.id],
              )
            ).rows;
            const chosen = body.organizationId
              ? memberships.find((m) => m.organization_id === body.organizationId)
              : memberships[0];
            if (!chosen) throw new DomainError('FORBIDDEN', 'No organization membership');
            role = chosen.role;
            org = (
              await tx.query<OrgRow>(`SELECT ${ORG_COLUMNS} FROM organizations WHERE id = $1`, [
                chosen.organization_id,
              ])
            ).rows[0];
          }
          if (!org) throw new DomainError('FORBIDDEN', 'No organization membership');
          const orgIds = (
            await tx.query<{ organization_id: string }>(
              'SELECT organization_id FROM memberships WHERE user_id = $1',
              [user.id],
            )
          ).rows.map((r) => r.organization_id);
          return { user, org, role, orgIds };
        });

        const accessToken = signToken(
          {
            sub: identitySubject,
            email: result.user.email,
            name: result.user.display_name,
            org_ids: [result.org.id, ...result.orgIds.filter((o) => o !== result.org.id)],
            role: result.role,
          },
          opts.config.LOCAL_JWT_SECRET,
          opts.config.ACCESS_TOKEN_TTL_SECONDS,
        );
        return {
          accessToken,
          expiresAt: new Date(
            Date.now() + opts.config.ACCESS_TOKEN_TTL_SECONDS * 1000,
          ).toISOString(),
          user: userView(result.user),
          organization: orgView(result.org),
          role: result.role,
        };
      },
    );
  }

  app.get(
    '/me',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Current principal, organization, role, and permissions',
        response: { 200: MeResponseSchema, 401: ErrorEnvelopeSchema },
      },
    },
    async (req) => {
      const p = principalOf(req);
      const data = await opts.db.withSystem(async (tx) => {
        await tx.query("SELECT set_config('app.user_id', $1, true)", [p.userId]);
        const user = (
          await tx.query<UserRow>(
            'SELECT id, email, display_name, created_at FROM users WHERE id = $1',
            [p.userId],
          )
        ).rows[0] as UserRow;
        const memberships = (
          await tx.query<OrgRow & { role: Role }>(
            `SELECT o.id, o.name, o.plan, o.region, o.retention_days, o.monthly_budget_cents, o.status, m.role
             FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY m.created_at`,
            [p.userId],
          )
        ).rows;
        return { user, memberships };
      });
      const current = data.memberships.find((m) => m.id === p.organizationId);
      if (!current) throw new DomainError('FORBIDDEN', 'No organization membership');
      return {
        user: userView(data.user),
        organization: orgView(current),
        role: p.role,
        permissions: [...ROLE_PERMISSIONS[p.role]],
        memberships: data.memberships.map((m) => ({ organization: orgView(m), role: m.role })),
      };
    },
  );

  // Silence unused import in environments where dev-login is disabled.
  void z;
};
