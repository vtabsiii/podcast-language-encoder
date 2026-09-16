import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  DomainError,
  ForbiddenError,
  hasPermission,
  uuidv7,
  type Permission,
  type Role,
} from '@polycast/domain';
import type { AppConfig } from '../config.js';
import type { Db, Queryable } from '../db/pool.js';
import { CognitoVerifier } from './cognito.js';
import { verifyToken, type TokenClaims } from './jwt.js';

/** The tenant scope for a request. Comes from the token + membership, never from the body. */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly organizationId: string;
  readonly role: Role;
  readonly membershipIds: readonly string[];
}

/**
 * Who the caller is, independent of any organization. Set whenever the bearer token is valid,
 * including for a user who has no membership yet (first sign-in). Routes that only need to know
 * the person, such as creating a first organization, guard with `requireIdentity`.
 */
export interface Identity {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly subject: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity | null;
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

const USER_COLUMNS = 'id, email, display_name';
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Just-in-time provisioning: the identity provider is the source of truth for who exists, so
 * the first request carrying a valid token for an unseen subject creates the `users` row.
 * Membership is never provisioned here; it is granted through the API (organization creation)
 * or by an administrator.
 */
async function findOrCreateUser(tx: Queryable, claims: TokenClaims): Promise<UserRow> {
  const existing = (
    await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE identity_subject = $1`, [
      claims.sub,
    ])
  ).rows[0];
  if (existing) return existing;

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) throw new DomainError('UNAUTHENTICATED', 'Token missing email');
  const name = typeof claims.name === 'string' ? claims.name.trim() : '';
  const displayName = name || email.split('@')[0] || 'user';
  try {
    const inserted = (
      await tx.query<UserRow>(
        `INSERT INTO users (id, email, display_name, identity_subject) VALUES ($1,$2,$3,$4)
         ON CONFLICT (identity_subject) DO UPDATE SET updated_at = now()
         RETURNING ${USER_COLUMNS}`,
        [uuidv7(), email, displayName, claims.sub],
      )
    ).rows[0];
    if (!inserted) throw new DomainError('INTERNAL', 'Could not provision user');
    return inserted;
  } catch (err) {
    // Same email under a different subject (e.g. the user was recreated in the identity
    // provider): never silently re-bind an account; an operator has to reconcile it.
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION)
      throw new DomainError('FORBIDDEN', 'Email is already linked to another identity');
    throw err;
  }
}

/**
 * Resolves the bearer token to an Identity and, when a membership exists, a Principal:
 * token → user (by identity subject; created on first sight) → memberships → organization
 * chosen by X-Organization-Id (default: the first org in the token that the user belongs to,
 * else the oldest membership) → role. Requests without a token get `identity = principal = null`;
 * routes opt in to enforcement with `requireIdentity` / `requireAuth` / `requirePermission`.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app, opts) => {
  app.decorateRequest('identity', null);
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

    const resolved = await opts.db.withSystem(async (tx) => {
      const user = await findOrCreateUser(tx, claims);
      await tx.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
      const identity: Identity = {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        subject: claims.sub,
      };
      const memberships = (
        await tx.query<MembershipRow>(
          'SELECT organization_id, role FROM memberships WHERE user_id = $1 ORDER BY created_at',
          [user.id],
        )
      ).rows;
      if (memberships.length === 0) return { identity, principal: null };

      const isMember = (id: string) => memberships.some((x) => x.organization_id === id);
      // The token's org_ids only pick a default; membership itself lives in the database.
      const wanted = orgHeader ?? claims.org_ids.find(isMember) ?? memberships[0]?.organization_id;
      const m = memberships.find((x) => x.organization_id === wanted);
      if (!m) {
        // Same wording as an unknown org: membership existence is not leaked.
        throw new DomainError('FORBIDDEN', 'No organization membership');
      }
      const principal: Principal = {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        organizationId: m.organization_id,
        role: m.role,
        membershipIds: memberships.map((x) => x.organization_id),
      };
      return { identity, principal };
    });
    req.identity = resolved.identity;
    req.principal = resolved.principal;
  });
});

/** 401 without a token, 403 with a valid token but no organization membership. */
function assertPrincipal(req: FastifyRequest): Principal {
  if (req.principal) return req.principal;
  if (req.identity) throw new DomainError('FORBIDDEN', 'No organization membership');
  throw new DomainError('UNAUTHENTICATED', 'Authentication required');
}

/** Valid token required; a membership is not. */
export async function requireIdentity(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.identity) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  assertPrincipal(req);
}

export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const p = assertPrincipal(req);
    if (!hasPermission(p.role, permission)) throw new ForbiddenError(permission);
  };
}

/** Convenience accessor: throws if unauthenticated, so handlers never null-check. */
export function principalOf(req: FastifyRequest): Principal {
  return assertPrincipal(req);
}

/** Convenience accessor for routes guarded by `requireIdentity`. */
export function identityOf(req: FastifyRequest): Identity {
  if (!req.identity) throw new DomainError('UNAUTHENTICATED', 'Authentication required');
  return req.identity;
}

export type { FastifyInstance };
