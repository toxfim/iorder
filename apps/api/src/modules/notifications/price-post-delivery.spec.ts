import { describe, expect, it } from 'vitest';
import type { Clock } from '../../common/clock/clock.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { PRICE_LIST_POST_TYPE } from '../../common/outbox/price-list-post.js';
import type { IdentityService, StaffBotLinkService } from '../identity/index.js';
import type { OrdersService } from '../orders/index.js';
import type { OrganizationsService } from '../organizations/index.js';
import type { PriceListExport, PriceListExportService } from '../pricing/index.js';
import { FakeTelegramSender } from '../telegram/fake-telegram-sender.js';
import { WebLinks } from '../telegram/index.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import type { ClaimedNotification, OutboxRepository } from './outbox.repository.js';

const NOW = new Date('2026-10-28T04:00:00Z');
const PAYLOAD = { versionNumber: 7, dateLabel: '28.10.2026', usdRate: '11960.0000' };

const FILE: PriceListExport = {
  fileName: 'iorder-price-2026-10-28.xlsx',
  data: new Uint8Array([1, 2, 3]),
  versionNumber: 7,
  publishedAt: new Date('2026-10-27T08:00:00Z'),
  publishedAtLabel: '27.10.2026 13:00',
  dateLabel: '28.10.2026',
  rateLabel: '11 960',
  rowCount: 3,
};

function row(organizationId: string, overrides: Partial<ClaimedNotification> = {}) {
  return {
    id: `row-${organizationId}`,
    type: PRICE_LIST_POST_TYPE,
    recipientKind: 'ORGANIZATION_CHAT' as const,
    recipientUserId: null,
    recipientRole: null,
    recipientOrganizationId: organizationId,
    orderId: null,
    payload: PAYLOAD,
    attempts: 1,
    deliveredChatIds: [],
    createdAt: NOW,
    ...overrides,
  };
}

function setup(
  rows: ClaimedNotification[],
  options: {
    baseUrl?: string;
    miniAppUrl?: string;
    file?: PriceListExport | null;
    chats?: Record<string, { chatId: string; active: boolean }>;
  } = {},
) {
  const results: Record<string, string> = {};
  const delivered: [string, string][] = [];
  const repository = {
    claimDue: () => Promise.resolve(rows),
    recordDelivered: (id: string, chatId: string) => {
      delivered.push([id, chatId]);
      return Promise.resolve();
    },
    markSent: (id: string) => {
      results[id] = 'SENT';
      return Promise.resolve();
    },
    markFailed: (id: string, code: string) => {
      results[id] = `FAILED:${code}`;
      return Promise.resolve();
    },
    scheduleRetry: (id: string, _at: Date, code: string) => {
      results[id] = `RETRY:${code}`;
      return Promise.resolve();
    },
    deferWithoutAttempt: (id: string) => {
      results[id] = 'DEFERRED';
      return Promise.resolve();
    },
    release: () => Promise.resolve(),
  } as unknown as OutboxRepository;
  const chats = options.chats ?? {
    'org-a': { chatId: '-1001', active: true },
    'org-b': { chatId: '-1002', active: true },
  };
  const organizations = {
    findChatTarget: (id: string) => Promise.resolve(chats[id] ?? null),
  } as unknown as OrganizationsService;
  let builds = 0;
  const file = options.file === undefined ? FILE : options.file;
  const priceExport = {
    buildCurrent: () => {
      builds += 1;
      return file === null ? Promise.reject(new NotFoundError('none')) : Promise.resolve(file);
    },
  } as unknown as PriceListExportService;
  const sender = new FakeTelegramSender();
  const dispatcher = new OutboxDispatcher(
    repository,
    sender,
    {} as IdentityService,
    organizations,
    {} as OrdersService,
    new WebLinks(
      'baseUrl' in options ? options.baseUrl : 'https://order.example.uz/',
      options.miniAppUrl,
    ),
    { now: () => NOW } as Clock,
    {} as StaffBotLinkService,
    priceExport,
  );
  return { dispatcher, sender, results, delivered, builds: () => builds };
}

describe('PRICE_LIST_POST delivery', () => {
  it('sends the file to each group with the date and rate caption and a url button, building it once per batch', async () => {
    const { dispatcher, sender, results, delivered, builds } = setup([row('org-a'), row('org-b')]);
    const summary = await dispatcher.runOnce();
    expect(summary).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(builds()).toBe(1);
    expect(sender.documents.map((d) => d.chatId)).toEqual(['-1001', '-1002']);
    expect(sender.documents[0]?.file).toEqual({ fileName: FILE.fileName, data: FILE.data });
    expect(sender.documents[0]?.options).toEqual({
      caption:
        'Sana: 28.10.2026\nKurs: 11 960 UZS\nBuyurtma berish uchun tugmani bosishingiz mumkin',
      button: { text: 'Buyurtma berish', url: 'https://order.example.uz/prices' },
    });
    expect(sender.sent).toHaveLength(0);
    expect(delivered).toEqual([
      ['row-org-a', '-1001'],
      ['row-org-b', '-1002'],
    ]);
    expect(results).toEqual({ 'row-org-a': 'SENT', 'row-org-b': 'SENT' });
  });

  it('the button opens the Mini App on the catalog when TELEGRAM_MINI_APP_URL is set', async () => {
    for (const [miniAppUrl, expected] of [
      ['https://t.me/iorder_bot/shop', 'https://t.me/iorder_bot/shop?startapp=prices'],
      ['https://t.me/iorder_bot', 'https://t.me/iorder_bot?startapp=prices'],
    ] as const) {
      const { dispatcher, sender } = setup([row('org-a')], { miniAppUrl });
      await dispatcher.runOnce();
      expect(sender.documents[0]?.options?.button).toEqual({
        text: 'Buyurtma berish',
        url: expected,
      });
    }
  });

  it('leaves the rate line out without a rate and the button and its hint out without any link', async () => {
    const { dispatcher, sender } = setup([row('org-a')], {
      baseUrl: undefined,
      file: { ...FILE, rateLabel: null },
    });
    await dispatcher.runOnce();
    expect(sender.documents[0]?.options).toEqual({ caption: 'Sana: 28.10.2026' });
  });

  it('fails a row for good when nothing is published at send time', async () => {
    const { dispatcher, sender, results } = setup([row('org-a')], { file: null });
    await dispatcher.runOnce();
    expect(sender.documents).toHaveLength(0);
    expect(results).toEqual({ 'row-org-a': 'FAILED:NO_PRICE_LIST' });
  });

  it('refuses a payload outside the allow-list and an inactive or unknown organization', async () => {
    const { dispatcher, sender, results } = setup(
      [
        row('org-a', { payload: { ...PAYLOAD, purchasePrice: '1.00' } }),
        row('org-b'),
        row('org-x'),
      ],
      {
        chats: {
          'org-a': { chatId: '-1001', active: true },
          'org-b': { chatId: '-1002', active: false },
        },
      },
    );
    await dispatcher.runOnce();
    expect(sender.documents).toHaveLength(0);
    expect(results).toEqual({
      'row-org-a': 'FAILED:INVALID_PAYLOAD',
      'row-org-b': 'FAILED:ORGANIZATION_INACTIVE',
      'row-org-x': 'FAILED:NO_RECIPIENT',
    });
  });

  it('does not send again to a group the row already reached', async () => {
    const { dispatcher, sender, results } = setup([row('org-a', { deliveredChatIds: ['-1001'] })]);
    await dispatcher.runOnce();
    expect(sender.documents).toHaveLength(0);
    expect(results).toEqual({ 'row-org-a': 'SENT' });
  });

  it('follows the retry policy: transient retried, rate limit deferred, unreachable failed', async () => {
    const { dispatcher, sender, results } = setup([row('org-a')]);
    sender.failFor('-1001', { failure: 'TRANSIENT' });
    await dispatcher.runOnce();
    expect(results['row-org-a']).toBe('RETRY:SEND_FAILED');

    const limited = setup([row('org-a')]);
    limited.sender.failFor('-1001', { failure: 'RATE_LIMITED', retryAfterSeconds: 5 });
    await limited.dispatcher.runOnce();
    expect(limited.results['row-org-a']).toBe('DEFERRED');

    const gone = setup([row('org-a')]);
    gone.sender.failFor('-1001', { failure: 'RECIPIENT_UNREACHABLE' });
    await gone.dispatcher.runOnce();
    expect(gone.results['row-org-a']).toBe('FAILED:RECIPIENT_UNREACHABLE');
  });
});
