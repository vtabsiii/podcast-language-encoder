import 'server-only';
import { cookies } from 'next/headers';
import { z } from 'zod';

export const SESSION_COOKIE = 'pc_session';
export const ORG_COOKIE = 'pc_org';
/** Display-only snapshot of who is signed in, so the topbar needs no API round-trip. */
export const WHO_COOKIE = 'pc_who';

const WhoSchema = z.object({
  email: z.string(),
  displayName: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.string(),
});
export type Who = z.infer<typeof WhoSchema>;

export interface Session {
  token: string;
  organizationId: string | null;
  who: Who | null;
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const organizationId = jar.get(ORG_COOKIE)?.value ?? null;
  let who: Who | null = null;
  const raw = jar.get(WHO_COOKIE)?.value;
  if (raw) {
    try {
      const parsed = WhoSchema.safeParse(JSON.parse(raw));
      who = parsed.success ? parsed.data : null;
    } catch {
      who = null;
    }
  }
  return { token, organizationId, who };
}
