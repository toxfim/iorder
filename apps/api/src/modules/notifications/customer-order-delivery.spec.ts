import { describe, expect, it } from 'vitest';
import type { Clock } from '../../common/clock/clock.js';
import type {
  DeliveryTarget,
  IdentityService,
  MentionSubject,
  StaffBotLinkService,
} from '../identity/index.js';
import type { OrdersService } from '../orders/index.js';
import type { OrganizationsService } from '../organizations/index.js';
import type { PriceListExportService } from '../pricing/index.js';
import { FakeTelegramSender } from '../telegram/fake-telegram-sender.js';
import { WebLinks } from '../telegram/index.js';
import { OutboxDispatcher } from './outbox-dispatcher.js';
import type { ClaimedNotification, OutboxRepository } from './outbox.repository.js';

// How an order message leaves for the customer side ([C] owner 2026-11-09): the organization's
// group gets two url buttons and a mention of the person who placed the order; the text carries
// no link. Everything around the dispatcher is a fake; nothing reaches Telegram or a database.

const NOW = new Date('2026-11-09T06:00:00Z');
const ORDER_ID = '0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';
const GROUP = '-1001';
const PAGE = `https://order.example.uz/orders/${ORDER_ID}`;
const MINI_APP = `https://t.me/iorder_bot/app?startapp=order_${ORDER_ID}`;
const APPROVED = "Buyurtma IO-10001 menejer tomonidan tasdiqlandi.\nSumma: 4 500 so'm";

function row(overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    id: 'row-1',
    type: 'ORDER_MANAGER_APPROVED',
    recipientKind: 'ORGANIZATION_CHAT',
    recipientUserId: null,
    recipientRole: null,
    recipientOrganizationId: 'org-a',
    orderId: ORDER_ID,
    payload: { orderNumber: 'IO-10001', totalAmount: '4500.00', currency: 'UZS' },
    attempts: 1,
    deliveredChatIds: [],
    createdAt: NOW,
    ...overrides,
  } as ClaimedNotification;
}

const person = (over: Partial<DeliveryTarget>): DeliveryTarget => ({
  userId: 'placer',
  chatId: '5550001',
  language: 'UZ',
  isStaff: false,
  membership: { organizationId: 'org-a', organizationActive: true },
  ...over,
});

function setup(
  rows: ClaimedNotification[],
  options: {
    baseUrl?: string | undefined;
    miniAppUrl?: string | undefined;
    placer?: MentionSubject | null;
    people?: Record<string, DeliveryTarget>;
    managers?: DeliveryTarget[];
  } = {},
) {
  const results: Record<string, string> = {};
  const repository = {
    claimDue: () => Promise.resolve(rows),
    recordDelivered: () => Promise.resolve(),
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
    deferWithoutAttempt: () => Promise.resolve(),
    release: () => Promise.resolve(),
  } as unknown as OutboxRepository;
  const placer =
    options.placer === undefined
      ? { fullName: 'Ali Valiyev', telegramUserId: '5550001' }
      : options.placer;
  const mentionLookups: string[] = [];
  const identity = {
    findDeliveryTarget: (userId: string) => Promise.resolve(options.people?.[userId] ?? null),
    findDeliveryTargetsByRole: () => Promise.resolve(options.managers ?? []),
    findMentionSubject: (userId: string) => {
      mentionLookups.push(userId);
      return Promise.resolve(placer);
    },
  } as unknown as IdentityService;
  const organizations = {
    findChatTarget: (id: string) =>
      Promise.resolve(id === 'org-a' ? { chatId: GROUP, active: true } : null),
  } as unknown as OrganizationsService;
  const orders = {
    findOrganizationIdOfOrder: () => Promise.resolve('org-a'),
    findPlacerIdOfOrder: () => Promise.resolve('placer'),
  } as unknown as OrdersService;
  const sender = new FakeTelegramSender();
  const dispatcher = new OutboxDispatcher(
    repository,
    sender,
    identity,
    organizations,
    orders,
    new WebLinks(
      'baseUrl' in options ? options.baseUrl : 'https://order.example.uz/',
      'miniAppUrl' in options ? options.miniAppUrl : 'https://t.me/iorder_bot/app',
      'https://staff.example.uz',
    ),
    { now: () => NOW } as Clock,
    { recordBlocked: () => Promise.resolve() } as unknown as StaffBotLinkService,
    {} as PriceListExportService,
  );
  return { dispatcher, sender, results, mentionLookups };
}

describe('an order message to the organization group', () => {
  it('has two url buttons, mentions the placer by id and writes no link in the text', async () => {
    const { dispatcher, sender, results } = setup([row()]);
    await dispatcher.runOnce();
    expect(results).toEqual({ 'row-1': 'SENT' });
    expect(sender.sent).toHaveLength(1);
    const [message] = sender.sent;
    const text = `${APPROVED}\nBuyurtmachi: Ali Valiyev`;
    expect(message).toEqual({
      chatId: GROUP,
      text,
      options: {
        disableLinkPreview: true,
        buttons: [
          { text: 'Ilovada ochish', url: MINI_APP },
          { text: 'Brauzerda ochish', url: PAGE },
        ],
        mentions: [{ offset: text.length - 'Ali Valiyev'.length, length: 11, userId: '5550001' }],
      },
    });
    expect(message?.text).not.toMatch(/https?:|t\.me/);
  });

  it('without TELEGRAM_MINI_APP_URL: only the browser button', async () => {
    const { dispatcher, sender } = setup([row()], { miniAppUrl: undefined });
    await dispatcher.runOnce();
    expect(sender.sent[0]?.options?.buttons).toEqual([{ text: 'Brauzerda ochish', url: PAGE }]);
  });

  it('without any address: no buttons, and still no link in the text', async () => {
    const { dispatcher, sender } = setup([row()], { baseUrl: undefined, miniAppUrl: undefined });
    await dispatcher.runOnce();
    expect(sender.sent[0]?.options).not.toHaveProperty('buttons');
    expect(sender.sent[0]?.text).not.toContain('http');
  });

  it('names a placer without a Telegram id in plain text, with no mention', async () => {
    const { dispatcher, sender } = setup([row()], {
      placer: { fullName: 'Ali Valiyev', telegramUserId: null },
    });
    await dispatcher.runOnce();
    expect(sender.sent[0]?.text).toBe(`${APPROVED}\nBuyurtmachi: Ali Valiyev`);
    expect(sender.sent[0]?.options).not.toHaveProperty('mentions');
  });

  it('sends the message without a placer line when the person is unknown', async () => {
    const { dispatcher, sender } = setup([row()], { placer: null });
    await dispatcher.runOnce();
    expect(sender.sent[0]?.text).toBe(APPROVED);
  });

  it('a name with markup characters and emoji goes out as written, mentioned as a whole', async () => {
    const name = '<b>Ali</b> & "Vali" \u{1F600}';
    const { dispatcher, sender } = setup([row()], {
      placer: { fullName: name, telegramUserId: '5550001' },
    });
    await dispatcher.runOnce();
    const message = sender.sent[0];
    expect(message?.text.endsWith(`Buyurtmachi: ${name}`)).toBe(true);
    const mention = message?.options?.mentions?.[0];
    expect(
      message?.text.slice(mention?.offset, (mention?.offset ?? 0) + (mention?.length ?? 0)),
    ).toBe(name);
  });

  it('a refusal reaches the group with the reason as written and the same buttons', async () => {
    const { dispatcher, sender } = setup([
      row({
        type: 'ORDER_CANCELLED',
        payload: {
          orderNumber: 'IO-10001',
          totalAmount: '4500.00',
          reason: 'Mijoz <so‘radi> & "x"',
        },
      }),
    ]);
    await dispatcher.runOnce();
    expect(sender.sent[0]?.text).toBe(
      'Buyurtma IO-10001 bekor qilindi.\nSabab: Mijoz <so‘radi> & "x"\nSumma: 4 500 so\'m\nBuyurtmachi: Ali Valiyev',
    );
    expect(sender.sent[0]?.options?.buttons).toHaveLength(2);
  });

  it('if Telegram refuses the message with the mention, it is sent again without it', async () => {
    const { dispatcher, sender, results } = setup([row()]);
    sender.failFor(GROUP, { failure: 'REJECTED', times: 1 });
    await dispatcher.runOnce();
    expect(sender.attempts).toEqual([GROUP, GROUP]);
    expect(results).toEqual({ 'row-1': 'SENT' });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toBe(`${APPROVED}\nBuyurtmachi: Ali Valiyev`);
    expect(sender.sent[0]?.options).not.toHaveProperty('mentions');
    expect(sender.sent[0]?.options?.buttons).toHaveLength(2);
  });

  it('a message Telegram keeps refusing fails the row as before', async () => {
    const { dispatcher, sender, results } = setup([row()]);
    sender.failFor(GROUP, { failure: 'REJECTED' });
    await dispatcher.runOnce();
    expect(results).toEqual({ 'row-1': 'FAILED:MESSAGE_REJECTED' });
  });
});

describe('an order message to the placer in private', () => {
  const privateRow = row({
    type: 'ORDER_CANCELLED',
    recipientKind: 'USER',
    recipientUserId: 'placer',
    recipientOrganizationId: null,
    payload: { orderNumber: 'IO-10001', totalAmount: '4500.00', reason: 'Xato buyurtma' },
  });

  it('opens the order page as a Mini App, has no placer line and looks nobody up to mention', async () => {
    const { dispatcher, sender, mentionLookups } = setup([privateRow], {
      people: { placer: person({ language: 'RU' }) },
    });
    await dispatcher.runOnce();
    expect(sender.sent).toEqual([
      {
        chatId: '5550001',
        text: 'Заказ IO-10001 отменён.\nПричина: Xato buyurtma\nСумма: 4 500 сум',
        options: {
          disableLinkPreview: true,
          buttons: [
            { text: 'Открыть в приложении', webAppUrl: PAGE },
            { text: 'Открыть в браузере', url: PAGE },
          ],
        },
      },
    ]);
    expect(mentionLookups).toEqual([]);
  });
});

describe('a staff order message', () => {
  it('keeps its two buttons and gets no placer line', async () => {
    const { dispatcher, sender, mentionLookups } = setup(
      [
        row({
          type: 'ORDER_SUBMITTED',
          recipientKind: 'ROLE',
          recipientRole: 'MANAGER',
          recipientOrganizationId: null,
        }),
      ],
      {
        managers: [
          person({ userId: 'm1', chatId: '777', language: 'EN', isStaff: true, membership: null }),
        ],
      },
    );
    await dispatcher.runOnce();
    const staffPage = `https://staff.example.uz/staff/orders/${ORDER_ID}`;
    expect(sender.sent).toEqual([
      {
        chatId: '777',
        text: "New order IO-10001. Waiting for manager approval.\nTotal: 4 500 so'm",
        options: {
          disableLinkPreview: true,
          buttons: [
            { text: 'Open on the website', url: staffPage },
            { text: 'Open in the Mini App', webAppUrl: staffPage },
          ],
        },
      },
    ]);
    expect(mentionLookups).toEqual([]);
  });
});
