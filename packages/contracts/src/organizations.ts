import { z } from 'zod';
import { OrganizationSchema } from './auth.js';
import { RoleSchema } from './common.js';

/**
 * Organization bootstrap for production sign-in (Cognito). A signed-in user with no
 * membership creates their first organization here and becomes its owner; the same request
 * lets an existing member create additional organizations. Tenant scope for everything else
 * still comes from the membership, never from a request body.
 */
export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(1).max(120),
});

export const CreateOrganizationResponseSchema = z.object({
  organization: OrganizationSchema,
  role: RoleSchema,
});

export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;
export type CreateOrganizationResponse = z.infer<typeof CreateOrganizationResponseSchema>;
