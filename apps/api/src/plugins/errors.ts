import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, type ErrorCode } from '@polycast/domain';
import type { ErrorEnvelope } from '@polycast/contracts';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ILLEGAL_TRANSITION: 409,
  CONSENT_REQUIRED: 422,
  CAPABILITY_UNAVAILABLE: 422,
  BUDGET_EXCEEDED: 402,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * Maps every thrown error to the standard envelope. Internal errors are logged with the
 * correlation id and returned without stack traces or provider details.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const correlationId = req.id;
    let body: ErrorEnvelope;
    let status: number;

    if (err instanceof DomainError) {
      status = STATUS[err.code];
      body = {
        code: err.code,
        message: err.message,
        correlationId,
        retryable: err.retryable,
        fieldErrors: [...(err.options.fieldErrors ?? [])],
        ...(err.options.details ? { details: { ...err.options.details } } : {}),
      };
    } else if (err instanceof ZodError || (err as { validation?: unknown }).validation) {
      const issues = err instanceof ZodError ? err.issues : [];
      status = 400;
      body = {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        correlationId,
        retryable: false,
        fieldErrors: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    } else if (
      typeof (err as { statusCode?: number }).statusCode === 'number' &&
      (err as { statusCode: number }).statusCode < 500
    ) {
      const e = err as { statusCode: number; message: string };
      status = e.statusCode;
      body = {
        code: e.statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED',
        message: e.message,
        correlationId,
        retryable: false,
        fieldErrors: [],
      };
    } else {
      req.log.error({ err, correlationId }, 'unhandled error');
      status = 500;
      body = {
        code: 'INTERNAL',
        message: 'Something went wrong. Quote the correlation id when reporting this.',
        correlationId,
        retryable: true,
        fieldErrors: [],
      };
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorEnvelope = {
      code: 'NOT_FOUND',
      message: 'Route not found',
      correlationId: req.id,
      retryable: false,
      fieldErrors: [],
    };
    void reply.status(404).send(body);
  });
}
