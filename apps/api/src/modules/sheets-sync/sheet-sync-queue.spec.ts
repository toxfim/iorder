import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../../common/errors/domain-errors.js';
import {
  PgBossSheetSyncQueue,
  SHEET_SYNC_QUEUE,
  UnavailableSheetSyncQueue,
  type SenderBossPort,
} from './sheet-sync-queue.js';

function fakeBoss(sendResults: (string | null)[]): SenderBossPort & {
  calls: string[];
  sent: unknown[];
} {
  const calls: string[] = [];
  const sent: unknown[] = [];
  return {
    calls,
    sent,
    start: vi.fn(async () => {
      calls.push('start');
      return undefined as never;
    }),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
    on: vi.fn(() => undefined as never),
    send: vi.fn(async (name: unknown, data?: unknown) => {
      calls.push(`send:${String(name)}`);
      sent.push(data);
      return sendResults.shift() ?? null;
    }) as unknown as SenderBossPort['send'],
  };
}

describe('PgBossSheetSyncQueue', () => {
  it('starts the sender once, sends the MANUAL payload to the sheet-sync queue and reports QUEUED', async () => {
    const boss = fakeBoss(['job-1', 'job-2']);
    const queue = new PgBossSheetSyncQueue(boss);
    expect(await queue.request()).toBe('QUEUED');
    expect(await queue.request()).toBe('QUEUED');
    expect(boss.calls).toEqual(['start', `send:${SHEET_SYNC_QUEUE}`, `send:${SHEET_SYNC_QUEUE}`]);
    expect(boss.sent).toEqual([{ trigger: 'MANUAL' }, { trigger: 'MANUAL' }]);
  });

  it('reports ALREADY_QUEUED when pg-boss refuses a second job (exclusive queue)', async () => {
    const queue = new PgBossSheetSyncQueue(fakeBoss(['job-1', null]));
    expect(await queue.request()).toBe('QUEUED');
    expect(await queue.request()).toBe('ALREADY_QUEUED');
  });

  it('stops the sender with the module only when it was started', async () => {
    const idle = fakeBoss([]);
    await new PgBossSheetSyncQueue(idle).onModuleDestroy();
    expect(idle.calls).toEqual([]);

    const used = fakeBoss(['job-1']);
    const queue = new PgBossSheetSyncQueue(used);
    await queue.request();
    await queue.onModuleDestroy();
    expect(used.calls.at(-1)).toBe('stop');
  });
});

describe('UnavailableSheetSyncQueue', () => {
  it('answers a 409 SHEET_SYNC_QUEUE_UNAVAILABLE conflict', async () => {
    const error = await new UnavailableSheetSyncQueue().request().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).reason).toBe('SHEET_SYNC_QUEUE_UNAVAILABLE');
  });
});
