import 'server-only';

/** Base URL of the control-plane API, server-side only. */
export const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      correlationId?: string;
    } | null;
    throw new Error(
      `${res.status} ${body?.message ?? res.statusText} (correlation ${body?.correlationId ?? 'n/a'})`,
    );
  }
  return (await res.json()) as T;
}
