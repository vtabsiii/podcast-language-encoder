/**
 * Domain error vocabulary. The API maps these to the standard error envelope
 * (`code`, `message`, `correlationId`, `fieldErrors`, `retryable`, `details`).
 * Codes are stable identifiers; messages are for humans and may change.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'CONFLICT',
  'ILLEGAL_TRANSITION',
  'CONSENT_REQUIRED',
  'CAPABILITY_UNAVAILABLE',
  'BUDGET_EXCEEDED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly options: {
      readonly retryable?: boolean;
      readonly fieldErrors?: readonly FieldError[];
      /** Safe for clients. Never put secrets, internal paths, or raw provider errors here. */
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

export class NotFoundError extends DomainError {
  override readonly name = 'NotFoundError';
  constructor(entity: string, id: string) {
    // Deliberately identical wording for "does not exist" and "exists in another tenant".
    super('NOT_FOUND', `${entity} not found`, { details: { entity, id } });
  }
}

export class ForbiddenError extends DomainError {
  override readonly name = 'ForbiddenError';
  constructor(action: string) {
    super('FORBIDDEN', `Not permitted to ${action}`);
  }
}

export class ConsentRequiredError extends DomainError {
  override readonly name = 'ConsentRequiredError';
  constructor(speakerId: string) {
    super('CONSENT_REQUIRED', 'Voice replica requires an active, scoped consent record', {
      details: { speakerId },
    });
  }
}

export class CapabilityUnavailableError extends DomainError {
  override readonly name = 'CapabilityUnavailableError';
  constructor(locale: string, capability: string) {
    super('CAPABILITY_UNAVAILABLE', `${capability} is not available for ${locale}`, {
      details: { locale, capability },
    });
  }
}
