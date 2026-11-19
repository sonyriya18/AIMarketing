/**
 * Structured API errors. Responses carry a stable code, a safe message, optional field
 * details, the request ID, and whether retrying can help. Stack traces and raw provider
 * errors are never sent to clients.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../observability/logger';

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'invalid_request'
  | 'unprocessable'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'capability_unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  invalid_request: 400,
  unprocessable: 422,
  rate_limited: 429,
  dependency_unavailable: 503,
  capability_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryable = false
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError('forbidden', msg);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId;
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'The request is not valid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
        retryable: false,
      },
    });
  }
  const anyErr = err as { type?: string; code?: string; status?: number };
  if (anyErr?.type === 'entity.too.large' || anyErr?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'The upload is larger than the allowed limit', requestId, retryable: false } });
  }
  if (anyErr?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_request', message: 'The request body is not valid JSON', requestId, retryable: false } });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.warn('request failed', { requestId, code: err.code, message: err.message });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId, retryable: err.retryable },
    });
  }
  logger.error('unhandled error', { requestId, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  return res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server', requestId, retryable: true } });
}
