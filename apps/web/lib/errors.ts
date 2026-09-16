import type { ErrorEnvelope } from '@polycast/contracts';

/** Error thrown by both the server-side and client-side API helpers. Carries the envelope. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    public readonly status: number,
    public readonly envelope: Partial<ErrorEnvelope>,
  ) {
    super(envelope.message ?? `Request failed with status ${status}`);
  }

  get correlationId(): string {
    return this.envelope.correlationId ?? 'n/a';
  }

  get retryable(): boolean {
    return this.envelope.retryable ?? false;
  }

  fieldError(path: string): string | undefined {
    return this.envelope.fieldErrors?.find((f) => f.path === path)?.message;
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    return `${e.message} (${e.envelope.code ?? e.status}, correlation ${e.correlationId})`;
  }
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}

/** Build an ApiError from a non-2xx Response, tolerating non-JSON bodies. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as Partial<ErrorEnvelope> | null;
  return new ApiError(res.status, body ?? { message: res.statusText || `HTTP ${res.status}` });
}
