import { z } from 'zod';
import { ROLES } from '@polycast/domain';

export const IdSchema = z.string().uuid();
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const MicrosecondsSchema = z.number().int().nonnegative();
export const LocaleTagSchema = z.string().regex(/^[a-z]{2}-[A-Z0-9]{2,3}$/);
export const RoleSchema = z.enum(ROLES);

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
