import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Clock } from '../../common/clock/clock.js';
import { TelegramInitDataVerifier } from '../telegram/init-data-verifier.js';
import { createActorResolver } from './identity.module.js';
import type { IdentityRepository } from './identity.repository.js';
import { TelegramActorResolver } from './telegram-actor.resolver.js';
import type { ActiveMembershipView, UserView } from './user.view.js';

const TOKEN = '555:FAKE-unit-test-token';
const NOW = new Date('2026-10-25T10:00:00Z');

class FixedClock extends Clock {
  now(): Date {
    return NOW;
  }
}

function initDataFor(id: number, token: string = TOKEN): string {
  const fields: [string, string][] = [
    ['auth_date', String(NOW.getTime() / 1000)],
    ['user', JSON.stringify({ id, first_name: 'T' })],
  ];
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const check = fields
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams([...fields, ['hash', hash]]).toString();
}

const contextWith = (authorization: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as unknown as ExecutionContext;

function user(overrides: Partial<UserView> = {}): UserView {
  return {
    id: 'u-1',
    telegramUserId: 42n,
    fullName: 'T',
    phone: null,
    language: 'UZ',
    status: 'ACTIVE',
    staffRoles: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const membership = (overrides: Partial<ActiveMembershipView> = {}): ActiveMembershipView => ({
  userId: 'u-1',
  organizationId: 'org-1',
  organizationName: 'Shop',
  organizationActive: true,
  role: 'SELLER',
  joinedAt: NOW,
  ...overrides,
});

function resolverWith(found: UserView | null, memberships: ActiveMembershipView[] = []) {
  const repository = {
    findByTelegramId: vi.fn().mockResolvedValue(found),
    findActiveMemberships: vi.fn().mockResolvedValue(memberships),
  } as unknown as IdentityRepository;
  const verifier = new TelegramInitDataVerifier({ botToken: TOKEN, clock: new FixedClock() });
  return { resolver: new TelegramActorResolver(verifier, repository), repository };
}

describe('TelegramActorResolver', () => {
  it('builds a staff actor from the roles and ignores any membership', async () => {
    const { resolver, repository } = resolverWith(user({ staffRoles: ['MANAGER', 'DRIVER'] }), [
      membership(),
    ]);
    const actor = await resolver.resolve(contextWith(`tma ${initDataFor(42)}`));
    expect(actor).toEqual({ userId: 'u-1', staffRoles: ['MANAGER', 'DRIVER'] });
    expect(repository.findActiveMemberships).not.toHaveBeenCalled();
  });

  it('never gives a Mini App actor a session id (logout and /auth/session rely on it)', async () => {
    const staff = await resolverWith(user({ staffRoles: ['ADMIN'] })).resolver.resolve(
      contextWith(`tma ${initDataFor(42)}`),
    );
    const customer = await resolverWith(user(), [membership()]).resolver.resolve(
      contextWith(`tma ${initDataFor(42)}`),
    );
    for (const actor of [staff, customer]) {
      expect(actor).not.toBeNull();
      expect(actor).not.toHaveProperty('sessionId');
    }
  });

  it('builds a customer actor from the active membership', async () => {
    const { resolver } = resolverWith(user(), [membership({ role: 'SHOP_OWNER' })]);
    expect(await resolver.resolve(contextWith(`TMA ${initDataFor(42)}`))).toEqual({
      userId: 'u-1',
      staffRoles: [],
      membership: { organizationId: 'org-1', role: 'SHOP_OWNER' },
    });
  });

  it.each([
    ['unknown user', null, []],
    ['blocked user', user({ status: 'BLOCKED', staffRoles: ['ADMIN'] }), []],
    ['no role and no membership', user(), []],
    ['inactive organization', user(), [membership({ organizationActive: false })]],
  ])('returns no actor: %s', async (_name, found, memberships) => {
    const { resolver } = resolverWith(found, memberships);
    expect(await resolver.resolve(contextWith(`tma ${initDataFor(42)}`))).toBeNull();
  });

  it.each([
    undefined,
    42,
    '',
    'tma',
    'tma   ',
    'Bearer abc',
    `tma${initDataFor(42)}`,
    'basic tma x',
  ])('returns no actor for the header %j without touching the database', async (header) => {
    const { resolver, repository } = resolverWith(user({ staffRoles: ['ADMIN'] }));
    expect(await resolver.resolve(contextWith(header))).toBeNull();
    expect(repository.findByTelegramId).not.toHaveBeenCalled();
  });

  it('looks the user up by the id inside the SIGNED data, as a bigint', async () => {
    const { resolver, repository } = resolverWith(null);
    await resolver.resolve(contextWith(`tma ${initDataFor(777_000_111)}`));
    expect(repository.findByTelegramId).toHaveBeenCalledWith(777000111n);
  });
});

// Part of the 2026-11-09 security review: with one bot the init data the CUSTOMER Mini App holds
// for a staff member also opened /staff routes. A separate staff bot closes that.
describe('TelegramActorResolver bound to a staff Mini App bot', () => {
  const STAFF_TOKEN = '777:FAKE-staff-bot-token';
  const ORDERING_ORG = 'org-test-orders';

  function boundResolver(
    found: UserView | null,
    memberships: ActiveMembershipView[] = [],
    staffOrderingOrganizationId: string | null = null,
  ) {
    const repository = {
      findByTelegramId: vi.fn().mockResolvedValue(found),
      findActiveMemberships: vi.fn().mockResolvedValue(memberships),
    } as unknown as IdentityRepository;
    const clock = new FixedClock();
    const resolver = new TelegramActorResolver(
      new TelegramInitDataVerifier({ botToken: TOKEN, clock }),
      repository,
      {
        staffVerifier: new TelegramInitDataVerifier({ botToken: STAFF_TOKEN, clock }),
        staffOrderingOrganizationId,
      },
    );
    return { resolver, repository };
  }

  const fromMainBot = contextWith(`tma ${initDataFor(42)}`);
  const fromStaffBot = contextWith(`tma ${initDataFor(42, STAFF_TOKEN)}`);

  it('staff bot init data makes the staff actor', async () => {
    const { resolver } = boundResolver(user({ staffRoles: ['MANAGER', 'DRIVER'] }));
    expect(await resolver.resolve(fromStaffBot)).toEqual({
      userId: 'u-1',
      staffRoles: ['MANAGER', 'DRIVER'],
    });
  });

  it.each([['MANAGER'], ['ADMIN'], ['ACCOUNTANT'], ['PURCHASING_MANAGER']] as const)(
    'main bot init data of a %s makes only the staff viewer, never a staff actor',
    async (role) => {
      const { resolver } = boundResolver(user({ staffRoles: [role] }), [], ORDERING_ORG);
      expect(await resolver.resolve(fromMainBot)).toEqual({
        userId: 'u-1',
        staffRoles: [],
        staffViewer: { staffRoles: [role], orderingOrganizationId: ORDERING_ORG },
      });
    },
  );

  it.each([['DRIVER'], ['WAREHOUSE_MANAGER']] as const)(
    'main bot init data of a %s (no customer app for that role) makes no actor at all',
    async (role) => {
      const { resolver } = boundResolver(user({ staffRoles: [role] }));
      expect(await resolver.resolve(fromMainBot)).toBeNull();
    },
  );

  it('main bot init data still makes a customer member', async () => {
    const { resolver } = boundResolver(user(), [membership({ role: 'SHOP_OWNER' })]);
    expect(await resolver.resolve(fromMainBot)).toEqual({
      userId: 'u-1',
      staffRoles: [],
      membership: { organizationId: 'org-1', role: 'SHOP_OWNER' },
    });
  });

  it('staff bot init data never makes a customer member (the staff bot is not a customer door)', async () => {
    const { resolver, repository } = boundResolver(user(), [membership()]);
    expect(await resolver.resolve(fromStaffBot)).toBeNull();
    expect(repository.findActiveMemberships).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown user', null],
    ['blocked staff member', user({ status: 'BLOCKED', staffRoles: ['ADMIN'] })],
  ])('makes no actor from either bot: %s', async (_name, found) => {
    for (const context of [fromMainBot, fromStaffBot]) {
      expect(await boundResolver(found).resolver.resolve(context)).toBeNull();
    }
  });

  it('init data signed by a third bot is refused without touching the database', async () => {
    const { resolver, repository } = boundResolver(user({ staffRoles: ['ADMIN'] }));
    const other = contextWith(`tma ${initDataFor(42, '999:FAKE-some-other-bot')}`);
    expect(await resolver.resolve(other)).toBeNull();
    expect(repository.findByTelegramId).not.toHaveBeenCalled();
  });
});

describe('wiring: no bypass', () => {
  const repository = {} as IdentityRepository;

  it('has NO resolver when no bot token is configured (the app fails closed)', () => {
    expect(createActorResolver({ BOT_TOKEN: undefined }, new FixedClock(), repository)).toBeNull();
  });

  it('passes the configured init data max age to the verifier (default 24 hours)', async () => {
    class TwoHoursLater extends Clock {
      now(): Date {
        return new Date(NOW.getTime() + 2 * 3600 * 1000);
      }
    }
    const found = {
      findByTelegramId: vi.fn().mockResolvedValue(user({ staffRoles: ['MANAGER'] })),
      findActiveMemberships: vi.fn().mockResolvedValue([]),
    } as unknown as IdentityRepository;
    const header = contextWith(`tma ${initDataFor(42)}`);
    const byDefault = createActorResolver({ BOT_TOKEN: TOKEN }, new TwoHoursLater(), found);
    expect(await byDefault?.resolve(header)).not.toBeNull();
    const strict = createActorResolver(
      { BOT_TOKEN: TOKEN, TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: 3600 },
      new TwoHoursLater(),
      found,
    );
    expect(await strict?.resolve(header)).toBeNull();
  });

  it('logs ONE warning without any token content when there is no token', () => {
    const warn = vi.fn();
    createActorResolver({ BOT_TOKEN: undefined }, new FixedClock(), repository, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Telegram identity disabled: Mini App sign-in answers 401');
  });

  it('logs nothing when a token is configured', () => {
    const warn = vi.fn();
    createActorResolver({ BOT_TOKEN: TOKEN }, new FixedClock(), repository, { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('binds staff actors to the staff bot only when STAFF_MINI_APP_BOT_TOKEN is set', async () => {
    const staffToken = '777:FAKE-staff-bot-token';
    const found = {
      findByTelegramId: vi.fn().mockResolvedValue(user({ staffRoles: ['MANAGER'] })),
      findActiveMemberships: vi.fn().mockResolvedValue([]),
    } as unknown as IdentityRepository;
    const main = contextWith(`tma ${initDataFor(42)}`);
    const staff = contextWith(`tma ${initDataFor(42, staffToken)}`);

    // Not set (today): the main bot signs staff in and the other bot is nobody.
    const unbound = createActorResolver({ BOT_TOKEN: TOKEN }, new FixedClock(), found);
    expect(await unbound?.resolve(main)).toEqual({ userId: 'u-1', staffRoles: ['MANAGER'] });
    expect(await unbound?.resolve(staff)).toBeNull();

    const bound = createActorResolver(
      {
        BOT_TOKEN: TOKEN,
        STAFF_MINI_APP_BOT_TOKEN: staffToken,
        STAFF_ORDERING_ORGANIZATION_ID: 'org-9',
      },
      new FixedClock(),
      found,
    );
    expect(await bound?.resolve(staff)).toEqual({ userId: 'u-1', staffRoles: ['MANAGER'] });
    expect(await bound?.resolve(main)).toEqual({
      userId: 'u-1',
      staffRoles: [],
      staffViewer: { staffRoles: ['MANAGER'], orderingOrganizationId: 'org-9' },
    });
  });

  it('has the Telegram resolver when a token is configured', () => {
    expect(createActorResolver({ BOT_TOKEN: TOKEN }, new FixedClock(), repository)).toBeInstanceOf(
      TelegramActorResolver,
    );
  });

  it('keeps DEVELOPER_TELEGRAM_ID and the token out of the request path', () => {
    const root = new URL('../../', import.meta.url);
    const sourceFiles = (dir: URL): URL[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? sourceFiles(new URL(`${entry.name}/`, dir))
          : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
            ? [new URL(entry.name, dir)]
            : [],
      );
    const mentions = (needle: string): string[] =>
      sourceFiles(root)
        .filter((file) => !file.pathname.includes('/generated/'))
        .filter((file) => readFileSync(file, 'utf8').includes(needle))
        .map((file) => file.pathname.slice(root.pathname.length))
        .sort();

    // Only the one-off CLI reads the developer id (env.ts just documents why it is absent).
    expect(mentions('DEVELOPER_TELEGRAM_ID')).toEqual([
      'cli/seed-admin.main.ts',
      'cli/seed-admin.ts',
      'config/env.ts',
    ]);
    // Only the env schema, the two modules that build something from it (the actor resolver,
    // the bot) and the one-off deployment CLI that sets the bots' command menus may read the token.
    expect(mentions('BOT_TOKEN')).toEqual([
      'cli/bot-set-commands.main.ts',
      'config/env.ts',
      'modules/identity/identity.module.ts',
      'modules/telegram/telegram.module.ts',
    ]);
  });
});
