import { Body, Controller, Get, Logger, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock, ClockModule } from './common/clock/clock.js';
import { ConflictError } from './common/errors/domain-errors.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { applyBodyLimit, JSON_BODY_LIMIT } from './common/http/body-limit.js';
import { HealthController } from './health/health.controller.js';

// Test-only controller. Its constructor injection proves decorator metadata survives the
// test transformer; if it did not, `clock` would be undefined at runtime.
@Controller('probe')
class ProbeController {
  constructor(private readonly clock: Clock) {}

  @Get('now')
  now(): { iso: string } {
    return { iso: this.clock.now().toISOString() };
  }

  @Post('conflict')
  conflict(): never {
    throw new ConflictError('Order is not in the expected status', 'DRAFT_NOT_OPEN');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Post('crash')
  crash(): never {
    throw new Error('relation "orders" does not exist');
  }
}

describe('HTTP application wiring', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClockModule],
      controllers: [HealthController, ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyBodyLimit(app);
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('injects services through constructor metadata', async () => {
    const response = await fetch(`${baseUrl}/probe/now`);
    const body = (await response.json()) as { iso: string };
    expect(Number.isNaN(Date.parse(body.iso))).toBe(false);
  });

  it('maps a domain error to 409 with a stable error body', async () => {
    const response = await fetch(`${baseUrl}/probe/conflict`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Order is not in the expected status',
        reason: 'DRAFT_NOT_OPEN',
      },
    });
  });

  it('returns a generic 500 without internals for unexpected errors', async () => {
    const response = await fetch(`${baseUrl}/probe/crash`, { method: 'POST' });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('orders');
    expect(text).not.toContain('at ');
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('answers an oversized JSON body with 413 PAYLOAD_TOO_LARGE, not 500, and does not log an error', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await fetch(`${baseUrl}/probe/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filler: 'x'.repeat(3 * 1024 * 1024) }),
    });
    const text = await response.text();
    expect(response.status).toBe(413);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
    expect(text).not.toContain(JSON_BODY_LIMIT);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('answers a malformed JSON body with 400, not 500, without echoing or logging the body', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = await fetch(`${baseUrl}/probe/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password": hunter2',
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Request could not be read' },
    });
    expect(text).not.toContain('hunter2');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('still accepts a body just under the limit', async () => {
    const response = await fetch(`${baseUrl}/probe/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filler: 'x'.repeat(90 * 1024) }),
    });
    expect(response.status).toBe(201);
  });
});
