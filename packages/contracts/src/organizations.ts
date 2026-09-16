import { z } from 'zod';
import { OrganizationSchema } from './auth.js';
import { RoleSchema } from './common.js';

/**
 * Self-service organization creation. Any authenticated identity may create an organization
 * and becomes its owner; this is how a freshly signed-in user (Cognito or local) gets their
 * first membership. Tenant scope is never taken from the body: the caller becomes the owner.
 */
export const CreateOrganizationRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const CreateOrganizationResponseSchema = z.object({
  organization: OrganizationSchema,
  role: RoleSchema,
});

export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;
export type CreateOrganizationResponse = z.infer<typeof CreateOrganizationResponseSchema>;
