import { describe, expect, it } from 'vitest';
import type { Clock } from '../../common/clock/clock.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  BotConnectOutcome,
  IdentityService,
  StaffBotLinkService,
  TelegramPerson,
} from '../identity/index.js';
import type { BrandService, CatalogService, ProductImagesService } from '../catalog/index.js';
import type { OrganizationsService } from '../organizations/index.js';
import {
  PriceListExportService,
  type PriceListView,
  type PricingService,
  type UsdRateService,
} from '../pricing/index.js';
import type { BotEvent } from './bot-events.js';
import { FakeTelegramSender } from './fake-telegram-sender.js';
import { COMMAND_LIMIT } from './command-rate-limiter.js';
import { TelegramCommandService } from './telegram-command.service.js';
import { WebLinks } from './web-links.js';

type CommandEvent = Extract<BotEvent, { kind: 'COMMAND' }>;
type ChoiceEvent = Extract<BotEvent, { kind: 'LANGUAGE_CHOSEN' }>;

const BASE_URL = 'https://app.example.uz';

function member(overrides: Partial<TelegramPerson> = {}): TelegramPerson {
  return {
    userId: 'u1',
    telegramUserId: 111n,
    fullName: 'Alice',
    language: 'UZ',
    status: 'ACTIVE',
    staffRoles: [],
    membership: {
      userId: 'u1',
      organizationId: 'o1',
      organizationName: 'Alpha',
      organizationActive: true,
      role: 'SELLER',
      joinedAt: new Date('2026-10-01T00:00:00Z'),
    },
    ...overrides,
  };
}

const MINI_APP_URL = 'https://t.me/iorder_bot/shop';

const PUBLISHED_LIST: PriceListView = {
  version: {
    id: 'v1',
    number: 7,
    status: 'PUBLISHED',
    publishedAt: new Date('2026-10-20T08:00:00Z'),
    publishedBy: 'staff-user-1',
    note: null,
    source: 'MANUAL',
    createdAt: new Date('2026-10-19T08:00:00Z'),
  },
  items: [
    {
      product: {
        id: 'p1',
        productCode: 'A-1',
        category: null,
        categoryId: null,
        trackingType: 'NONE',
        markingRequired: false,
        codeRuleConfigured: false,
        isActive: true,
        codeGenerated: false,
        mergedIntoProductId: null,
        brandId: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
        translations: [{ lang: 'UZ', name: 'Kabel', description: null }],
      },
      basePrice: new Prisma.Decimal('12500'),
      deferredPrice: null,
      rrp: null,
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      currency: 'UZS',
      uzs: {
        basePrice: new Prisma.Decimal('12500'),
        deferredPrice: null,
        rrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: null,
        alifDeferredPrice: null,
      },
      usd: null,
    },
  ],
  usdRate: null,
  priceTier: null,
};

interface SetupOptions {
  baseUrl?: string | undefined;
  miniAppUrl?: string | undefined;
  /** Whether the group the command comes from belongs to an ACTIVE organization. */
  chatActive?: boolean;
  /** The organization that owns the group (default o1, the one  belongs to). */
  chatOrganizationId?: string;
  /** false = no price list has been published. */
  published?: boolean;
  /** What a staff connect link does when pressed. */
  connectOutcome?: BotConnectOutcome;
}

function setup(person: TelegramPerson | null, options: SetupOptions = {}) {
  const sender = new FakeTelegramSender();
  const time = { now: new Date('2026-10-21T09:00:00Z') };
  const clock = { now: () => time.now } as Clock;
  const languages: { telegramUserId: bigint; language: string }[] = [];
  const identity = {
    findTelegramPerson: () => Promise.resolve(person),
    setLanguageByTelegram: (telegramUserId: bigint, language: string) => {
      languages.push({ telegramUserId, language });
      return Promise.resolve(person === null ? 'NO_USER' : 'CHANGED');
    },
  } as unknown as IdentityService;
  const organizations = {
    findPriceTier: () => Promise.resolve('STANDARD'),
    findActiveOrganizationIdByChat: () =>
      Promise.resolve(options.chatActive === false ? null : (options.chatOrganizationId ?? 'o1')),
  } as unknown as OrganizationsService;
  const pricing = {
    getCurrentForExport: () =>
      options.published === false
        ? Promise.reject(new NotFoundError('none'))
        : Promise.resolve(PUBLISHED_LIST),
  } as unknown as PricingService;
  const botLinks = {
    connected: [] as { payload: string; telegramUserId: bigint }[],
    started: [] as bigint[],
    connectByStart(payload: string, person: { telegramUserId: bigint }) {
      this.connected.push({ payload, telegramUserId: person.telegramUserId });
      return Promise.resolve(options.connectOutcome ?? 'CONNECTED');
    },
    recordStarted(telegramUserId: bigint) {
      this.started.push(telegramUserId);
      return Promise.resolve();
    },
  };
  const service = new TelegramCommandService(
    identity,
    sender,
    new WebLinks('baseUrl' in options ? options.baseUrl : BASE_URL, options.miniAppUrl),
    clock,
    organizations,
    new PriceListExportService(
      pricing,
      { getStockQuantities: () => Promise.resolve(new Map()) } as unknown as CatalogService,
      { resolveBrands: () => Promise.resolve(new Map()) } as unknown as BrandService,
      {
        primaryThumbnailsForExport: () => Promise.resolve(new Map()),
      } as unknown as ProductImagesService,
      { readSnapshot: () => Promise.resolve(null) } as unknown as UsdRateService,
      clock,
      { availableFrom: () => Promise.resolve(new Map()) } as never,
    ),
    botLinks as unknown as StaffBotLinkService,
  );
  return { service, sender, time, botLinks, languages };
}

const command = (
  name: CommandEvent['command'],
  overrides: Partial<CommandEvent> = {},
): CommandEvent => ({
  kind: 'COMMAND',
  command: name,
  chatId: 555n,
  chatType: 'private',
  person: { telegramUserId: 111n, fullName: 'Alice', language: 'UZ' },
  eventAt: new Date('2026-10-20T08:00:00Z'),
  ...overrides,
});

const choice = (language: ChoiceEvent['language'], startPayload?: string): ChoiceEvent => ({
  kind: 'LANGUAGE_CHOSEN',
  callbackQueryId: 'cb-1',
  chatId: 555n,
  messageId: 42,
  person: { telegramUserId: 111n, fullName: 'Alice', language: 'UZ' },
  language,
  ...(startPayload === undefined ? {} : { startPayload }),
});

describe('/start asks the language first [C, owner 2026-11-13]', () => {
  it('answers a private /start with one trilingual question and three language buttons', async () => {
    const { service, sender, languages } = setup(member({ language: 'RU' }));
    expect(await service.handle(command('start'))).toBe('REPLIED');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toBe('Tilni tanlang\nВыберите язык\nChoose a language');
    expect(sender.sent[0]?.options?.buttons).toEqual([
      { text: "🇺🇿 O'zbekcha", callbackData: 'lang:uz' },
      { text: '🇷🇺 Русский', callbackData: 'lang:ru' },
      { text: '🇺🇸 English', callbackData: 'lang:en' },
    ]);
    // Nothing is saved or recorded before the choice.
    expect(languages).toEqual([]);
  });

  it('carries a binding payload in the buttons and binds nothing yet', async () => {
    const LINK = `staff_${'a'.repeat(43)}`;
    const { service, sender, botLinks } = setup(null);
    await service.handle(command('start', { startPayload: LINK }));
    expect(botLinks.connected).toEqual([]);
    expect(sender.sent[0]?.options?.buttons?.[1]).toEqual({
      text: '🇷🇺 Русский',
      callbackData: `lang:ru:${LINK}`,
    });
  });

  it('does not carry another payload (a plain start after the choice)', async () => {
    const { service, sender } = setup(null);
    await service.handle(command('start', { startPayload: 'promo_1' }));
    expect(sender.sent[0]?.options?.buttons?.[0]).toEqual({
      text: "🇺🇿 O'zbekcha",
      callbackData: 'lang:uz',
    });
  });

  it('asks the same question on a private /lang, with no payload [owner 2026-11-14]', async () => {
    const { service, sender, languages } = setup(member({ language: 'RU' }));
    expect(await service.handle(command('lang'))).toBe('REPLIED');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.text).toBe('Tilni tanlang\nВыберите язык\nChoose a language');
    expect(
      sender.sent[0]?.options?.buttons?.map((b) => ('callbackData' in b ? b.callbackData : null)),
    ).toEqual(['lang:uz', 'lang:ru', 'lang:en']);
    expect(languages).toEqual([]);
  });

  it('answers a group /lang with the command list, never the question [P]', async () => {
    const { service, sender } = setup(member());
    await service.handle(command('lang', { chatId: -100n, chatType: 'group' }));
    expect(sender.sent[0]?.text).toContain('/lang');
    expect(sender.sent[0]?.options?.buttons).toBeUndefined();
  });

  it('keeps a group /start as it was: the app link, no question', async () => {
    const { service, sender, languages } = setup(member());
    await service.handle(command('start', { chatId: -100n, chatType: 'group' }));
    expect(sender.sent[0]?.text).toContain('Assalomu alaykum');
    expect(sender.sent[0]?.text).toContain(`${BASE_URL}/`);
    expect(sender.sent[0]?.options?.buttons).toBeUndefined();
    expect(languages).toEqual([]);
  });
});

describe('a language button pressed', () => {
  it.each([
    ['UZ', 'Buyruqlar:'],
    ['RU', 'Команды:'],
    ['EN', 'Commands:'],
  ] as const)(
    'saves %s for a known person, records the start and explains the commands',
    async (language, heading) => {
      const { service, sender, botLinks, languages } = setup(member());
      expect(await service.handleLanguageChosen(choice(language))).toBe('REPLIED');
      expect(sender.answeredCallbacks).toEqual(['cb-1']);
      expect(sender.clearedButtons).toEqual([{ chatId: '555', messageId: 42 }]);
      expect(languages).toEqual([{ telegramUserId: 111n, language }]);
      expect(botLinks.started).toEqual([111n]);
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.text).toContain(heading);
      expect(sender.sent[0]?.text).toContain('/price');
      expect(sender.sent[0]?.text).toContain(`${BASE_URL}/`);
    },
  );

  it('answers a stranger in the chosen language and records no start', async () => {
    const { service, sender, botLinks } = setup(null);
    await service.handleLanguageChosen(choice('EN'));
    expect(botLinks.started).toEqual([]);
    expect(sender.sent[0]?.text).toContain('Commands:');
  });

  it('says the web app is not set up when WEB_APP_URL is missing, without a broken link', async () => {
    const { service, sender } = setup(member(), { baseUrl: undefined });
    await service.handleLanguageChosen(choice('EN'));
    expect(sender.sent[0]?.text).toContain('not set up yet');
    expect(sender.sent[0]?.text).not.toContain('http');
  });

  it('drops a carried payload that binds nothing (a crafted press)', async () => {
    const { service, sender, botLinks } = setup(member());
    await service.handleLanguageChosen(choice('UZ', 'promo_1'));
    expect(botLinks.connected).toEqual([]);
    expect(sender.sent).toHaveLength(1);
  });

  it('answers any other press so that the app stops waiting', async () => {
    const { service, sender } = setup(member());
    await service.handleIgnoredPress('cb-x');
    expect(sender.answeredCallbacks).toEqual(['cb-x']);
    expect(sender.sent).toEqual([]);
  });
});

describe('a staff connect link, after the language', () => {
  const LINK = `staff_${'a'.repeat(43)}`;

  it.each([
    ['CONNECTED', 'Bildirishnomalar yoqildi'],
    ['INVALID_LINK', 'eskirgan'],
    ['OTHER_TELEGRAM_ACCOUNT', 'boshqa Telegram akkauntiga'],
    ['TELEGRAM_TAKEN', 'boshqa odamga'],
  ] as const)(
    '%s: connects, says so and explains the commands in one message',
    async (outcome, text) => {
      const { service, sender, botLinks } = setup(null, { connectOutcome: outcome });
      expect(await service.handleLanguageChosen(choice('UZ', LINK))).toBe('REPLIED');
      expect(botLinks.connected).toEqual([{ payload: LINK, telegramUserId: 111n }]);
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.text).toContain(text);
      expect(sender.sent[0]?.text).toContain('Buyruqlar:');
    },
  );

  it('answers in the chosen language', async () => {
    const { service, sender } = setup(null);
    await service.handleLanguageChosen(choice('RU', LINK));
    expect(sender.sent[0]?.text).toContain('Уведомления включены');
  });
});

describe('/price', () => {
  it('sends the Excel file with a caption and the Mini App button to a member of an ACTIVE organization', async () => {
    const { service, sender } = setup(member(), { miniAppUrl: MINI_APP_URL });
    expect(await service.handle(command('price'))).toBe('REPLIED');
    expect(sender.sent).toHaveLength(0);
    const document = sender.documents[0];
    expect(document?.chatId).toBe('555');
    expect(document?.file.fileName).toBe('iorder-price-2026-10-21.xlsx');
    expect(document?.file.data.byteLength).toBeGreaterThan(0);
    expect(document?.options?.caption).toContain('Versiya 7');
    expect(document?.options?.caption).toContain('20.10.2026 13:00');
    expect(document?.options?.button).toEqual({ text: 'Ilovada ochish', url: MINI_APP_URL });
  });

  it('sends only the file when the Mini App link is not configured', async () => {
    const { service, sender } = setup(member());
    await service.handle(command('price'));
    expect(sender.documents).toHaveLength(1);
    expect(sender.documents[0]?.options?.button).toBeUndefined();
  });

  it('names the file by the Asia/Tashkent date of the fake clock', async () => {
    const { service, sender, time } = setup(member());
    time.now = new Date('2026-10-21T19:30:00Z');
    await service.handle(command('price'));
    expect(sender.documents[0]?.file.fileName).toBe('iorder-price-2026-10-22.xlsx');
  });

  it('answers a private chat in the language of the person', async () => {
    const { service, sender } = setup(member({ language: 'EN' }));
    await service.handle(command('price'));
    expect(sender.documents[0]?.options?.caption).toContain('Current price list');
  });

  it('answers a group in UZ whatever the language of the person', async () => {
    const { service, sender } = setup(member({ language: 'RU' }));
    await service.handle(command('price', { chatId: -100n, chatType: 'group' }));
    expect(sender.documents[0]?.options?.caption).toContain('Joriy narxlar');
  });

  it('refuses in a group whose organization is not ACTIVE, even for an active member', async () => {
    const { service, sender } = setup(member(), { chatActive: false });
    expect(await service.handle(command('price', { chatId: -100n, chatType: 'group' }))).toBe(
      'REPLIED',
    );
    expect(sender.documents).toHaveLength(0);
    expect(sender.sent[0]?.text).toContain("a'zolari");
  });

  it('refuses an active member of organization A in the active group of organization B', async () => {
    const { service, sender } = setup(member(), { chatOrganizationId: 'o2' });
    expect(await service.handle(command('price', { chatId: -200n, chatType: 'group' }))).toBe(
      'REPLIED',
    );
    expect(sender.documents).toHaveLength(0);
    expect(sender.sent[0]?.text).toContain("a'zolari");
  });

  it('lets staff use the price command in any active organization group', async () => {
    const { service, sender } = setup(member({ staffRoles: ['MANAGER'], membership: null }), {
      chatOrganizationId: 'o2',
    });
    await service.handle(command('price', { chatId: -200n, chatType: 'group' }));
    expect(sender.documents).toHaveLength(1);
  });

  it('says so when no price list is published, and sends no file', async () => {
    const { service, sender } = setup(member(), { published: false });
    expect(await service.handle(command('price'))).toBe('REPLIED');
    expect(sender.documents).toHaveLength(0);
    expect(sender.sent[0]?.text).toContain("e'lon qilinmagan");
  });

  it('is rate limited like the other commands', async () => {
    const { service, sender } = setup(member());
    for (let i = 0; i < COMMAND_LIMIT; i += 1) await service.handle(command('price'));
    expect(await service.handle(command('price'))).toBe('RATE_LIMITED');
    expect(sender.documents).toHaveLength(COMMAND_LIMIT);
  });

  it('reports SEND_FAILED without throwing when Telegram refuses the file', async () => {
    const { service, sender } = setup(member());
    sender.failFor('555', { failure: 'TRANSIENT' });
    expect(await service.handle(command('price'))).toBe('SEND_FAILED');
  });

  it.each(['REJECTED', 'TRANSIENT', 'RATE_LIMITED'] as const)(
    'tells the person the file could not be sent after a %s failure',
    async (failure) => {
      const { service, sender } = setup(member());
      sender.failFor('555', { failure, times: 1 });
      expect(await service.handle(command('price'))).toBe('SEND_FAILED');
      expect(sender.documents).toHaveLength(0);
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]?.text).toContain("yuborib bo'lmadi");
    },
  );

  it('stays silent when the chat is unreachable, and survives a failing failure reply', async () => {
    const { service, sender } = setup(member());
    sender.failFor('555', { failure: 'RECIPIENT_UNREACHABLE' });
    expect(await service.handle(command('price'))).toBe('SEND_FAILED');
    expect(sender.attempts).toEqual(['555']);

    const second = setup(member());
    second.sender.failFor('555', { failure: 'TRANSIENT' });
    expect(await second.service.handle(command('price'))).toBe('SEND_FAILED');
    expect(second.sender.attempts).toEqual(['555', '555']);
  });

  it.each([
    ['an unknown person', null],
    ['a person without a membership', member({ membership: null })],
    [
      'a member of an INACTIVE organization',
      member({
        membership: {
          userId: 'u1',
          organizationId: 'o1',
          organizationName: 'Alpha',
          organizationActive: false,
          role: 'SELLER',
          joinedAt: new Date('2026-10-01T00:00:00Z'),
        },
      }),
    ],
    ['a blocked member', member({ status: 'BLOCKED' })],
  ])('refuses %s with a short message and no file', async (_name, person) => {
    const { service, sender } = setup(person);
    expect(await service.handle(command('price'))).toBe('REPLIED');
    expect(sender.sent[0]?.text).toContain("a'zolari");
    expect(sender.sent[0]?.text).not.toContain('http');
    expect(sender.documents).toHaveLength(0);
  });

  it('gives an active staff member the file too', async () => {
    const { service, sender } = setup(member({ staffRoles: ['MANAGER'], membership: null }));
    await service.handle(command('price'));
    expect(sender.documents).toHaveLength(1);
  });

  it('refuses in the language of the stored person in a private chat', async () => {
    const { service, sender } = setup(member({ language: 'RU', membership: null }));
    await service.handle(command('price'));
    expect(sender.sent[0]?.text).toContain('участникам организации');
  });
});

describe('/help', () => {
  it('lists the commands, with no link and no database access needed for the text', async () => {
    const { service, sender } = setup(member({ language: 'EN' }));
    await service.handle(command('help'));
    expect(sender.sent[0]?.text).toContain('/price');
    expect(sender.sent[0]?.text).toContain('/start');
  });
});

describe('limits and failures', () => {
  it('stops answering a chat that sends too many commands, per chat', async () => {
    const { service, sender, time } = setup(member());
    const outcomes: string[] = [];
    for (let i = 0; i < COMMAND_LIMIT + 2; i += 1)
      outcomes.push(await service.handle(command('help')));
    expect(outcomes.filter((o) => o === 'REPLIED')).toHaveLength(COMMAND_LIMIT);
    expect(outcomes.slice(COMMAND_LIMIT)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    expect(sender.sent).toHaveLength(COMMAND_LIMIT);

    // Another chat is not affected, and the first one recovers after the window.
    expect(await service.handle(command('help', { chatId: 777n }))).toBe('REPLIED');
    time.now = new Date(time.now.getTime() + 60_000);
    expect(await service.handle(command('help'))).toBe('REPLIED');
  });

  it('keeps one member from using up the budget of the others in the same group', async () => {
    const { service } = setup(member());
    const spammer = command('help', { chatId: -100n, chatType: 'group' });
    for (let i = 0; i < COMMAND_LIMIT + 3; i += 1) await service.handle(spammer);
    expect(await service.handle(spammer)).toBe('RATE_LIMITED');
    const other = command('help', {
      chatId: -100n,
      chatType: 'group',
      person: { telegramUserId: 222n, fullName: 'Bob', language: 'UZ' },
    });
    expect(await service.handle(other)).toBe('REPLIED');
  });

  it('does not throw when Telegram refuses the reply', async () => {
    const { service, sender } = setup(member());
    sender.failFor('555', { failure: 'RECIPIENT_UNREACHABLE' });
    expect(await service.handle(command('start'))).toBe('SEND_FAILED');
  });

  it('does nothing when no bot token is configured', async () => {
    const sender = new FakeTelegramSender(false);
    const identity = {
      findTelegramPerson: () => Promise.resolve(null),
    } as unknown as IdentityService;
    const clock = { now: () => new Date() } as Clock;
    const service = new TelegramCommandService(
      identity,
      sender,
      new WebLinks(BASE_URL),
      clock,
      {} as OrganizationsService,
      {} as PriceListExportService,
      {} as StaffBotLinkService,
    );
    expect(await service.handle(command('start'))).toBe('DISABLED');
    expect(sender.sent).toHaveLength(0);
  });
});
