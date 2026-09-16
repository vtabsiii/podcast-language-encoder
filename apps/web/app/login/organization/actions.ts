'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { MeResponse } from '@polycast/contracts';
import { apiFetch } from '@/lib/api';
import { loadWho, organizationExpiry, setOrganization, tokenClaims } from '@/lib/auth-session';
import { loginUrl } from '@/lib/auth-urls';
import { ApiError, describeError } from '@/lib/errors';
import { safeNext } from '@/lib/safe-next';
import { SESSION_COOKIE, type Who } from '@/lib/session';

export interface OrganizationState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

/** `POST /api/v1/organizations` answers 201 with the new organization and the caller's role. */
interface CreateOrganizationResponse {
  organization: MeResponse['organization'];
  role: MeResponse['role'];
}

/**
 * Creates the principal's first (or another) organization and scopes the session to it. The
 * organization id in the cookies comes from the API response, never from the form.
 */
export async function createOrganization(
  _prev: OrganizationState,
  form: FormData,
): Promise<OrganizationState> {
  const next = safeNext(form.get('next'));
  const name = String(form.get('name') ?? '').trim();
  if (name.length === 0 || name.length > 120) {
    return {
      error: 'Check the highlighted fields.',
      fieldErrors: { name: 'Enter a name of 1–120 characters.' },
    };
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) redirect(loginUrl(next));

  let created: CreateOrganizationResponse;
  try {
    // No `x-organization-id`: the principal may have no membership at all yet.
    created = await apiFetch<CreateOrganizationResponse>('/api/v1/organizations', {
      method: 'POST',
      body: { name },
      token,
      organizationId: null,
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect(loginUrl(next, 'session'));
    const fieldError = e instanceof ApiError ? e.fieldError('name') : undefined;
    return {
      error: describeError(e),
      ...(fieldError ? { fieldErrors: { name: fieldError } } : {}),
    };
  }

  let who: Who;
  try {
    who = await loadWho(token, created.organization.id);
  } catch {
    // The organization exists; do not make the user create a second one over a transient
    // profile failure. Fall back to the token's own claims for the display snapshot.
    const claims = tokenClaims(token);
    who = {
      email: claims.email ?? '',
      displayName: claims.name ?? claims.email ?? '',
      organizationId: created.organization.id,
      organizationName: created.organization.name,
      role: created.role,
    };
  }
  setOrganization(jar, who, organizationExpiry(token));
  redirect(next);
}
