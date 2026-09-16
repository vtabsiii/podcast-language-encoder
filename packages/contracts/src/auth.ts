import { z } from 'zod';
import { PERMISSIONS } from '@polycast/domain';
import { IdSchema, IsoTimestampSchema, RoleSchema } from './common.js';

/**
 * Local (Cognito-compatible) sign-in used outside production. The token carries the same
 * claims Cognito will (`sub`, `email`, `org_ids`, `role`) so API and UI code paths are identical.
 */
export const DevLoginRequestSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120).optional(),
  /** Join an existing organization (must already have a membership) … */
  organizationId: IdSchema.optional(),
  /** … or create a new one with this name and become its owner. */
  organizationName: z.string().min(1).max(120).optional(),
  /** Role to grant when creating the membership in a brand-new organization. */
  role: RoleSchema.optional(),
});

export const UserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  displayName: z.string(),
  createdAt: IsoTimestampSchema,
});

export const OrganizationSchema = z.object({
  id: IdSchema,
  name: z.string(),
  plan: z.string(),
  region: z.string(),
  retentionDays: z.number().int().positive(),
  monthlyBudgetCents: z.number().int().nonnegative().nullable(),
  status: z.enum(['active', 'suspended', 'deleting']),
});

export const MembershipSummarySchema = z.object({
  organization: OrganizationSchema,
  role: RoleSchema,
});

export const DevLoginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: IsoTimestampSchema,
  user: UserSchema,
  organization: OrganizationSchema,
  role: RoleSchema,
});

export const MeResponseSchema = z.object({
  user: UserSchema,
  organization: OrganizationSchema,
  role: RoleSchema,
  permissions: z.array(z.enum(PERMISSIONS)),
  memberships: z.array(MembershipSummarySchema),
});

export type DevLoginRequest = z.infer<typeof DevLoginRequestSchema>;
export type DevLoginResponse = z.infer<typeof DevLoginResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
