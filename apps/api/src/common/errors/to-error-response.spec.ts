import { CONFLICT_REASONS, errorBodySchema } from '@iorder/shared';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
} from './domain-errors.js';
import { toErrorResponse } from './to-error-response.js';

describe('toErrorResponse', () => {
  it.each([
    [new NotFoundError('Order not found'), 404, 'NOT_FOUND'],
    [new ConflictError('Illegal transition', 'DRAFT_NOT_OPEN'), 409, 'CONFLICT'],
    [new UnauthenticatedError('Authentication required'), 401, 'UNAUTHENTICATED'],
    [new ForbiddenError('Not allowed'), 403, 'FORBIDDEN'],
    [new InputValidationError([{ path: 'qty', message: 'Required' }]), 422, 'VALIDATION_FAILED'],
  ])('maps %o to HTTP %i', (error, status, code) => {
    const response = toErrorResponse(error);
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('maps the oversized-body error of the body parser to 413 PAYLOAD_TOO_LARGE without internals', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      limit: 102400,
      length: 3145728,
    });
    const response = toErrorResponse(tooLarge);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
  });

  it('maps a malformed or unreadable body (the body parser, not an HttpException) to 400 without the body', () => {
    // What body-parser 2.x really hands over: the SyntaxError of JSON.parse decorated with a
    // type tag, a status and the raw body. V8 quotes a fragment of the input in the message.
    const malformed = Object.assign(
      new SyntaxError(`Unexpected token 'h', "{"password": hunter2" is not valid JSON`),
      { type: 'entity.parse.failed', status: 400, expose: true, body: '{"password": hunter2' },
    );
    const unsupported = Object.assign(new Error('unsupported charset "KOI8-R"'), {
      type: 'charset.unsupported',
      status: 415,
      charset: 'koi8-r',
    });
    for (const exception of [malformed, unsupported]) {
      const response = toErrorResponse(exception);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Request could not be read' },
      });
    }
    expect(JSON.stringify(toErrorResponse(malformed))).not.toContain('hunter2');
  });

  it('does not mistake a server-side body parser fault or an unrelated tagged error for a client error', () => {
    const serverSide = Object.assign(new Error('stream encoding should not be set'), {
      type: 'stream.encoding.set',
      status: 500,
    });
    expect(toErrorResponse(serverSide).status).toBe(500);
    expect(
      toErrorResponse(Object.assign(new Error('x'), { type: 'other', status: 400 })).status,
    ).toBe(500);
  });

  it('adds the machine-readable reason to CONFLICT bodies only, next to details', () => {
    const conflict = toErrorResponse(
      new ConflictError('Inactive', 'INACTIVE_PRODUCT_IN_DRAFT', { productIds: ['p1'] }),
    );
    expect(conflict.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Inactive',
      reason: 'INACTIVE_PRODUCT_IN_DRAFT',
      details: { productIds: ['p1'] },
    });
    for (const other of [
      new NotFoundError('x'),
      new ForbiddenError('x'),
      new UnauthenticatedError('x'),
      new InputValidationError([]),
    ]) {
      expect('reason' in toErrorResponse(other).body.error).toBe(false);
    }
  });

  it('every conflict reason in the shared list passes the shared error body schema', () => {
    for (const reason of CONFLICT_REASONS) {
      const { body } = toErrorResponse(new ConflictError('x', reason));
      expect(errorBodySchema.safeParse(body).success, reason).toBe(true);
    }
  });

  it('answers 429 with a Retry-After header for rate limited errors only', () => {
    const limited = toErrorResponse(new RateLimitedError(42));
    expect(limited.status).toBe(429);
    expect(limited.headers).toEqual({ 'Retry-After': '42' });
    expect(toErrorResponse(new NotFoundError('x')).headers).toBeUndefined();
  });

  it('includes validation issues as details', () => {
    const issues = [{ path: 'qty', message: 'Required' }];
    expect(toErrorResponse(new InputValidationError(issues)).body.error.details).toEqual(issues);
  });

  it('keeps framework 4xx errors as client errors', () => {
    const response = toErrorResponse(new BadRequestException('Malformed JSON'));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('hides the cause of unknown errors', () => {
    const response = toErrorResponse(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(response.body.error.message).toBe('Internal server error');
  });

  it('never exposes a domain error without a client-facing status as its own message', () => {
    class UnmappedError extends DomainError {
      readonly code = 'UNMAPPED';
    }
    const response = toErrorResponse(new UnmappedError('secret internal detail'));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('secret internal detail');
  });
});
