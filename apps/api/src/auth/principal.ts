import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  DomainError,
  ForbiddenError,
  hasPermission,
  type Permission,
  type Role,
} from '@polycast/domain';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { CognitoVerifier } from './cognito.js';
import { verifyToken } from './jwt.js';

/** The tenant scope for a request. Comes from the token + membership, never from the body. */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly organizationId: string;
  readonly role: Role;
  readonly membershipIds: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AuthPluginOptions {
  config: AppConfig;
  db: Db;
}

interface MembershipRow {
  organization_id: string;
  role: Role;
}
interface UserRow {
  id: string;
  email: string;
  display_name: string;
}

/**
 * Resolves the bearer token to a Principal:
 * token → user (by identity subject) → memberships → organization chosen by X-Organization-Id
 * (default: the first org in the token) → role. Requests without a token get `principal = null`;
 * routes opt in to enforcement with `requireAuth` / `requirePermission`.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app, opts) => {
  app.decorateRequest('principal', null);
  const cognito =
    opts.config.AUTH_MODE === 'cognito'
      ? new CognitoVerifier({
          region: opts.config.AWS_REGION,
          userPoolId: opts.config.COGNITO_USER_POOL_ID ?? '',
          clientId: opts.config.COGNITO_CLIENT_ID,
        })
      : null;

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const claims = cognito
      ? await cognito.verify(header.slice(7))
      : verifyToken(header.slice(7), opts.config.LOCAL_JWT_SECRET);
    const requested = req.headers['x-organization-id'];
    const orgHeader = typeof requested === 'string' && requested.length > 0 ? requested : null;

    const principal = await opts.db.withSystem(async (tx) => {
      const user = (
        await tx.query<UserRow>(
          'SELECT id, email, display_name FROM users WHERE identity_subject = $1',
          [claims.sub],
        )
      ).rows[0];
      if (!user) throw new DomainError('UNAUTHENTICATED', 'Unknown user');
      await tx.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      const memberships = (
        await tx.query<MembershipRow>(
          'SELECT organization_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at',
          [user.id],
        )
      ).rows;
      if (memberships.length === 0)
        throw new DomainError('FORBIDDEN', 'No organization membership');
      const wanted = orgHeader ?? claims.org_ids[0] ?? memberships[0]?.organization_id;
      const m = memberships.find((x) => x.organization_id === wanted);
      if (!m) {
        // Same wording as an unknown org: membership existence is not leaked.
        throw new DomainError('FORBIDDEN', 'No organization membership');
      }
      const p: Principal = {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        organizationId: m.organization_id,
        role: m.role,
        membershipIds: memberships.map((x) => x.organization_id),
      };
      return p;
    });
    req.principal = principal;
  });
});

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
}

export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
    if (!hasPermission(req.principal.role, permission)) throw new ForbiddenError(permission);
  };
}

/** Convenience accessor: throws if unauthenticated, so handlers never null-check. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
  return req.principal;
}

export type { FastifyInstance };
