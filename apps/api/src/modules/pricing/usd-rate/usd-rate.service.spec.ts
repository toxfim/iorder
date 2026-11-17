import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../../common/auth/actor.js';
import type { Clock } from '../../../common/clock/clock.js';
import { ForbiddenError } from '../../../common/errors/domain-errors.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { AuditService } from '../../audit/index.js';
import type { UsdRateRepository } from './usd-rate.repository.js';
import type { UsdChannelRateProvider } from './usd-channel-rate-provider.js';
import type { UsdRateProvider } from './usd-rate-provider.js';
import { UsdRateService } from './usd-rate.service.js';

function make(): { service: UsdRateService; readState: ReturnType<typeof vi.fn> } {
  const readState = vi.fn().mockResolvedValue({
    channel: null,
    manual: {
      rate: new Prisma.Decimal('12650.5'),
      setBy: 'user-1',
      setAt: new Date('2026-10-20T08:00:00Z'),
      expiresAt: new Date('2026-10-21T08:00:00Z'),
    },
    bank: null,
  });
  const service = new UsdRateService(
    { readState } as unknown as UsdRateRepository,
    {} as UsdRateProvider,
    {} as UsdChannelRateProvider,
    {} as AuditService,
    { now: () => new Date('2026-10-20T09:00:00Z') } as Clock,
  );
  return { service, readState };
}

const staff = (...roles: string[]): Actor => ({ staffRoles: roles }) as unknown as Actor;

describe('UsdRateService.readSnapshotFor', () => {
  it.each(['MANAGER', 'ACCOUNTANT', 'ADMIN'])('lets the %s read the rate', async (role) => {
    const { service } = make();
    const snapshot = await service.readSnapshotFor(staff(role));
    expect(snapshot?.rate.toFixed(4)).toBe('12650.5000');
    expect(snapshot?.source).toBe('MANUAL');
  });

  it.each([['WAREHOUSE_MANAGER'], ['DRIVER'], []])(
    'refuses %s without reading anything',
    async (...roles) => {
      const { service, readState } = make();
      await expect(service.readSnapshotFor(staff(...roles))).rejects.toBeInstanceOf(ForbiddenError);
      expect(readState).not.toHaveBeenCalled();
    },
  );
});
