import { describe, expect, it, vi } from 'vitest';
import { priceListPostRecipientsResponseSchema } from '@iorder/shared/staff-cost';
import { InvalidResponseError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createFakeOrganizations } from '@/features/staff-organizations/api/fake-organizations-backend';
import { countPostRecipients } from '@/features/staff-brands/api/fake-brands-backend';
import { createHttpPriceListShareApi } from './price-list-share-api';

// CONTRACT test of the HTTP adapter for the price list file and post [C, owner 2026-11-11].

function setup(response: () => Response) {
  const fetchImpl = vi.fn(() => Promise.resolve(response()));
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, api: createHttpPriceListShareApi(http) };
}

const firstUrl = (fetchImpl: ReturnType<typeof setup>['fetchImpl']): string =>
  (fetchImpl.mock.calls[0] as unknown as [string])[0];

const RECIPIENTS = {
  recipients: {
    total: 3,
    byTier: { STANDARD: 1, WHOLESALE_PARTNER: 2, ALIF_FACTORING: 0 },
    byDestination: { GROUP: 2, PRIVATE: 1 },
  },
  skipped: { unbound: 2, inactive: 3, postingOff: 0, noPrices: 0 },
};

describe('createHttpPriceListShareApi', () => {
  it('asks for the file of the chosen tier', async () => {
    const { api, fetchImpl } = setup(
      () =>
        new Response(new Blob(['x']), {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="narx.xlsx"' },
        }),
    );
    await api.downloadExcel('WHOLESALE_PARTNER');
    expect(firstUrl(fetchImpl)).toBe(
      'https://api.test/staff/price-list/current/excel?tier=WHOLESALE_PARTNER',
    );
  });

  it('reads the recipients of a post with the strict shared schema', async () => {
    const ok = setup(() => new Response(JSON.stringify(RECIPIENTS), { status: 200 }));
    expect(await ok.api.recipients()).toEqual(RECIPIENTS);
    expect(firstUrl(ok.fetchImpl)).toBe(
      'https://api.test/staff/price-list/post-to-groups/recipients',
    );
    const extra = setup(
      () => new Response(JSON.stringify({ ...RECIPIENTS, names: ['x'] }), { status: 200 }),
    );
    await expect(extra.api.recipients()).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('countPostRecipients (fake)', () => {
  it('counts the demo organizations like the api: tier, chat kind, first skip reason', async () => {
    const orgs = await createFakeOrganizations().organizationsApi.list();
    const counted = countPostRecipients(orgs);
    expect(priceListPostRecipientsResponseSchema.safeParse(counted).success).toBe(true);
    expect(counted).toEqual(RECIPIENTS);
  });
});
