'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { DevLoginRequestSchema, type DevLoginResponse } from '@polycast/contracts';
import { apiFetch } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { ORG_COOKIE, SESSION_COOKIE, WHO_COOKIE, type Who } from '@/lib/session';

export interface LoginState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const secure = process.env.NODE_ENV === 'production';

export async function devLogin(_prev: LoginState, form: FormData): Promise<LoginState> {
  const mode = String(form.get('mode') ?? 'create');
  const raw = {
    email: String(form.get('email') ?? '').trim(),
    displayName: String(form.get('displayName') ?? '').trim() || undefined,
    ...(mode === 'join'
      ? { organizationId: String(form.get('organizationId') ?? '') || undefined }
      : { organizationName: String(form.get('organizationName') ?? '').trim() || undefined }),
  };
  const parsed = DevLoginRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'form';
      fieldErrors[key] ??= issue.message;
    }
    return { error: 'Check the highlighted fields.', fieldErrors };
  }
  if (!parsed.data.organizationId && !parsed.data.organizationName) {
    return {
      error: 'Choose an organization to join or name a new one.',
      fieldErrors: { organizationName: 'Required when creating an organization.' },
    };
  }

  let login: DevLoginResponse;
  try {
    login = await apiFetch<DevLoginResponse>('/api/v1/auth/dev-login', {
      method: 'POST',
      body: parsed.data,
      anonymous: true,
    });
  } catch (e) {
    return { error: describeError(e) };
  }

  const expires = new Date(login.expiresAt);
  const jar = await cookies();
  const base = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure, expires };
  jar.set(SESSION_COOKIE, login.accessToken, base);
  jar.set(ORG_COOKIE, login.organization.id, base);
  const who: Who = {
    email: login.user.email,
    displayName: login.user.displayName,
    organizationId: login.organization.id,
    organizationName: login.organization.name,
    role: login.role,
  };
  jar.set(WHO_COOKIE, JSON.stringify(who), base);

  const next = String(form.get('next') ?? '/');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}
