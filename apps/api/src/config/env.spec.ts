import { describe, expect, it } from 'vitest';
import { INIT_DATA_MAX_AGE_SECONDS } from '../modules/telegram/init-data-verifier.js';
import { isSheetSourceConfigured, parseEnv } from './env.js';

const validUrl = 'postgresql://user:secret-password@127.0.0.1:5433/db';

describe('parseEnv', () => {
  it('validates the payment plan change window', () => {
    const parse = (value: string) =>
      parseEnv({ DATABASE_URL: validUrl, PAYMENT_PLAN_CHANGE_WINDOW_SECONDS: value });
    expect(parse('').PAYMENT_PLAN_CHANGE_WINDOW_SECONDS).toBeUndefined();
    expect(parse('240').PAYMENT_PLAN_CHANGE_WINDOW_SECONDS).toBe(240);
    for (const bad of ['0', '-1', '1.5', '86401', 'soon']) expect(() => parse(bad)).toThrow();
  });

  it('the organization for staff orders is off by default and must be a uuid when set', () => {
    const parse = (value?: string) =>
      parseEnv({
        DATABASE_URL: validUrl,
        ...(value === undefined ? {} : { STAFF_ORDERING_ORGANIZATION_ID: value }),
      }).STAFF_ORDERING_ORGANIZATION_ID;
    // Unset and empty are the production state: no staff order is possible.
    expect(parse()).toBeUndefined();
    expect(parse('')).toBeUndefined();
    expect(parse('0198c0de-0000-7000-8000-000000000001')).toBe(
      '0198c0de-0000-7000-8000-000000000001',
    );
    // A typo must stop the boot, never silently mean "some organization".
    for (const bad of ['true', 'test-org', '0198c0de', ' ']) expect(() => parse(bad)).toThrow();
  });

  // Owner 2026-11-09: staging and production both run NODE_ENV=production, so "production never
  // takes a staff order" would rest on one line being absent from one file. The installation says
  // which one it is, and a production one refuses to start with the staff ordering line.
  describe('APP_ENVIRONMENT guards the staff ordering setting', () => {
    const ORG = '0198c0de-0000-7000-8000-000000000001';
    const deployed = {
      DATABASE_URL: validUrl,
      NODE_ENV: 'production',
      MEDIA_DIR: '/srv/media',
      TRUST_PROXY: '1',
    };

    it('is optional and accepts only the two installations', () => {
      expect(parseEnv({ DATABASE_URL: validUrl }).APP_ENVIRONMENT).toBeUndefined();
      expect(parseEnv({ DATABASE_URL: validUrl, APP_ENVIRONMENT: '' }).APP_ENVIRONMENT).toBe(
        undefined,
      );
      for (const value of ['staging', 'production']) {
        expect(parseEnv({ ...deployed, APP_ENVIRONMENT: value }).APP_ENVIRONMENT).toBe(value);
      }
      for (const bad of ['prod', 'dev', 'STAGING', 'test']) {
        expect(() => parseEnv({ ...deployed, APP_ENVIRONMENT: bad })).toThrow(/APP_ENVIRONMENT/);
      }
    });

    it('a deployed api takes the staff ordering line only when it says it is staging', () => {
      const withLine = { ...deployed, STAFF_ORDERING_ORGANIZATION_ID: ORG };
      expect(
        parseEnv({ ...withLine, APP_ENVIRONMENT: 'staging' }).STAFF_ORDERING_ORGANIZATION_ID,
      ).toBe(ORG);
      // Said to be production, or not said at all: the most restrictive reading, no start.
      expect(() => parseEnv({ ...withLine, APP_ENVIRONMENT: 'production' })).toThrow(
        /STAFF_ORDERING_ORGANIZATION_ID/,
      );
      expect(() => parseEnv(withLine)).toThrow(/STAFF_ORDERING_ORGANIZATION_ID/);
    });

    it('without the line every installation starts, marked or not', () => {
      for (const marker of [
        {},
        { APP_ENVIRONMENT: 'production' },
        { APP_ENVIRONMENT: 'staging' },
      ]) {
        expect(parseEnv({ ...deployed, ...marker }).STAFF_ORDERING_ORGANIZATION_ID).toBeUndefined();
      }
    });

    it('development and test runs are not deployed installations: the line needs no marker', () => {
      for (const mode of ['development', 'test']) {
        const env = parseEnv({
          DATABASE_URL: validUrl,
          NODE_ENV: mode,
          STAFF_ORDERING_ORGANIZATION_ID: ORG,
        });
        expect(env.STAFF_ORDERING_ORGANIZATION_ID).toBe(ORG);
      }
    });

    it('the refusal names the setting and never echoes the organization id', () => {
      try {
        parseEnv({ ...deployed, STAFF_ORDERING_ORGANIZATION_ID: ORG });
        throw new Error('expected parseEnv to throw');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('APP_ENVIRONMENT=staging');
        expect(message).not.toContain(ORG);
      }
    });
  });

  it('applies defaults for optional values', () => {
    const env = parseEnv({ DATABASE_URL: validUrl });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from a string', () => {
    expect(parseEnv({ DATABASE_URL: validUrl, PORT: '8080' }).PORT).toBe(8080);
  });

  it('validates configurable pending-group notification budgets', () => {
    const env = parseEnv({
      DATABASE_URL: validUrl,
      TELEGRAM_PENDING_NOTICES_PER_ADDER_PER_HOUR: '2',
      TELEGRAM_PENDING_NOTICES_PER_HOUR: '8',
    });
    expect(env.TELEGRAM_PENDING_NOTICES_PER_ADDER_PER_HOUR).toBe(2);
    expect(env.TELEGRAM_PENDING_NOTICES_PER_HOUR).toBe(8);
    for (const value of ['0', '-1', '1.5', 'invalid']) {
      expect(() =>
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_PENDING_NOTICES_PER_HOUR: value }),
      ).toThrow(/TELEGRAM_PENDING_NOTICES_PER_HOUR/);
    }
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-PostgreSQL URL', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/PostgreSQL/);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseEnv({ DATABASE_URL: validUrl, PORT: '70000' })).toThrow(/PORT/);
  });

  it('does not leak secret values in the error message', () => {
    try {
      parseEnv({ DATABASE_URL: 'mysql://user:secret-password@localhost/db' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });

  describe('BOT_TOKEN', () => {
    it('is optional, and an empty value means "not configured"', () => {
      expect(parseEnv({ DATABASE_URL: validUrl, BOT_TOKEN: '' }).BOT_TOKEN).toBeUndefined();
      expect(parseEnv({ DATABASE_URL: validUrl }).BOT_TOKEN).toBeUndefined();
    });

    it('accepts a token', () => {
      const env = parseEnv({ DATABASE_URL: validUrl, BOT_TOKEN: '123456:fake-token-value' });
      expect(env.BOT_TOKEN).toBe('123456:fake-token-value');
    });

    it.each(['short', 'has white space in-secret-token'])(
      'rejects the token %j without echoing it',
      (token) => {
        try {
          parseEnv({ DATABASE_URL: validUrl, BOT_TOKEN: token });
          expect.unreachable('parseEnv should have thrown');
        } catch (error) {
          expect(String(error)).toMatch(/BOT_TOKEN/);
          expect(String(error)).not.toContain(token);
        }
      },
    );
  });

  describe('TELEGRAM_INIT_DATA_MAX_AGE_SECONDS', () => {
    const parse = (value?: string) =>
      parseEnv({
        DATABASE_URL: validUrl,
        ...(value === undefined ? {} : { TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: value }),
      }).TELEGRAM_INIT_DATA_MAX_AGE_SECONDS;

    it('defaults to 24 hours, the same as the verifier default', () => {
      expect(parse()).toBe(86_400);
      expect(parse('')).toBe(86_400);
      expect(parse()).toBe(INIT_DATA_MAX_AGE_SECONDS);
    });

    it('accepts a positive integer up to 7 days', () => {
      expect(parse('3600')).toBe(3600);
      expect(parse('604800')).toBe(604_800);
    });

    it.each(['0', '-1', '1.5', 'abc', '604801'])('rejects %j', (value) => {
      expect(() => parse(value)).toThrow(/TELEGRAM_INIT_DATA_MAX_AGE_SECONDS/);
    });
  });

  describe('website session limits', () => {
    const parse = (name: string, value: string): unknown =>
      (parseEnv({ DATABASE_URL: validUrl, [name]: value }) as Record<string, unknown>)[name];

    it('are unset by default (the code defaults apply) and for an empty value', () => {
      const env = parseEnv({ DATABASE_URL: validUrl, STAFF_SESSION_IDLE_SECONDS: '' });
      expect(env.STAFF_SESSION_IDLE_SECONDS).toBeUndefined();
      expect(env.STAFF_SESSION_ABSOLUTE_SECONDS).toBeUndefined();
    });

    // The defaults of 2026-11-09 (14 days idle, 90 days absolute) must be expressible here too.
    it('accept the two-week idle limit and the 90-day absolute limit, up to 180 days', () => {
      expect(parse('STAFF_SESSION_IDLE_SECONDS', '1209600')).toBe(1_209_600);
      expect(parse('STAFF_SESSION_ABSOLUTE_SECONDS', '7776000')).toBe(7_776_000);
      expect(parse('STAFF_SESSION_ABSOLUTE_SECONDS', '15552000')).toBe(15_552_000);
    });

    it.each([
      ['STAFF_SESSION_IDLE_SECONDS', '59'],
      ['STAFF_SESSION_IDLE_SECONDS', '15552001'],
      ['STAFF_SESSION_ABSOLUTE_SECONDS', '299'],
      ['STAFF_SESSION_ABSOLUTE_SECONDS', '15552001'],
      ['STAFF_SESSION_ABSOLUTE_SECONDS', 'forever'],
    ])('reject %s=%j', (name, value) => {
      expect(() => parse(name, value)).toThrow(new RegExp(name));
    });
  });

  it('does not validate DEVELOPER_TELEGRAM_ID at boot (only the seed script does)', () => {
    const env = parseEnv({ DATABASE_URL: validUrl, DEVELOPER_TELEGRAM_ID: 'typo-12abc' });
    expect(env).not.toHaveProperty('DEVELOPER_TELEGRAM_ID');
  });

  describe('Telegram bot runtime', () => {
    const token = 'fake-token-for-tests-1234567890';
    const secret = 'a-valid-webhook-secret_123';

    it('TRUST_PROXY is a hop count: 0 by default and for an empty value, bounded integers only', () => {
      expect(parseEnv({ DATABASE_URL: validUrl }).TRUST_PROXY).toBe(0);
      expect(parseEnv({ DATABASE_URL: validUrl, TRUST_PROXY: '' }).TRUST_PROXY).toBe(0);
      expect(parseEnv({ DATABASE_URL: validUrl, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
      for (const bad of ['-1', '1.5', 'true', '99']) {
        expect(() => parseEnv({ DATABASE_URL: validUrl, TRUST_PROXY: bad })).toThrow(/TRUST_PROXY/);
      }
    });

    it('production refuses to boot without a proxy hop count (the throttles would key on the proxy)', () => {
      const production = {
        DATABASE_URL: validUrl,
        NODE_ENV: 'production',
        MEDIA_DIR: '/srv/media',
      };
      expect(() => parseEnv(production)).toThrow(/TRUST_PROXY/);
      expect(() => parseEnv({ ...production, TRUST_PROXY: '0' })).toThrow(/TRUST_PROXY/);
      expect(parseEnv({ ...production, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
      expect(parseEnv({ DATABASE_URL: validUrl, NODE_ENV: 'development' }).TRUST_PROXY).toBe(0);
    });

    it('MEDIA_DIR: absolute only, optional in development, required in production', () => {
      expect(parseEnv({ DATABASE_URL: validUrl }).MEDIA_DIR).toBeUndefined();
      expect(() => parseEnv({ DATABASE_URL: validUrl, MEDIA_DIR: 'media' })).toThrow(/MEDIA_DIR/);
      expect(() =>
        parseEnv({ DATABASE_URL: validUrl, NODE_ENV: 'production', TRUST_PROXY: '1' }),
      ).toThrow(/MEDIA_DIR/);
    });

    it('is off by default and for an empty value, with no token needed', () => {
      expect(parseEnv({ DATABASE_URL: validUrl }).TELEGRAM_MODE).toBe('off');
      expect(parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MODE: '' }).TELEGRAM_MODE).toBe('off');
    });

    it('needs a bot token for polling and webhook', () => {
      for (const mode of ['polling', 'webhook']) {
        expect(() =>
          parseEnv({
            DATABASE_URL: validUrl,
            TELEGRAM_MODE: mode,
            TELEGRAM_WEBHOOK_SECRET: secret,
          }),
        ).toThrow(/BOT_TOKEN/);
      }
      expect(
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MODE: 'polling', BOT_TOKEN: token })
          .TELEGRAM_MODE,
      ).toBe('polling');
    });

    it('needs the webhook secret for webhook mode and checks its alphabet', () => {
      expect(() =>
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MODE: 'webhook', BOT_TOKEN: token }),
      ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
      expect(() => parseEnv({ DATABASE_URL: validUrl, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(
        /TELEGRAM_WEBHOOK_SECRET/,
      );
      expect(() =>
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_WEBHOOK_SECRET: 'has a space in it 1234' }),
      ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
      const env = parseEnv({
        DATABASE_URL: validUrl,
        TELEGRAM_MODE: 'webhook',
        BOT_TOKEN: token,
        TELEGRAM_WEBHOOK_SECRET: secret,
      });
      expect(env.TELEGRAM_WEBHOOK_SECRET).toBe(secret);
    });

    it('rejects an unknown mode and does not echo the secret in errors', () => {
      expect(() => parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MODE: 'both' })).toThrow(
        /TELEGRAM_MODE/,
      );
      expect(() =>
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_WEBHOOK_SECRET: 'bad secret value!' }),
      ).toThrow(/^(?!.*bad secret value!)/s);
    });

    it('accepts only an http(s) WEB_APP_URL', () => {
      const url = 'https://app.example.uz';
      expect(parseEnv({ DATABASE_URL: validUrl, WEB_APP_URL: url }).WEB_APP_URL).toBe(url);
      expect(() => parseEnv({ DATABASE_URL: validUrl, WEB_APP_URL: 'ftp://example.uz' })).toThrow(
        /WEB_APP_URL/,
      );
      expect(parseEnv({ DATABASE_URL: validUrl, WEB_APP_URL: '' }).WEB_APP_URL).toBeUndefined();
    });

    it('accepts only an http(s) STAFF_WEB_APP_URL, and none at all', () => {
      const url = 'https://staff.example.uz';
      const parse = (value: string) =>
        parseEnv({ DATABASE_URL: validUrl, STAFF_WEB_APP_URL: value });
      expect(parse(url).STAFF_WEB_APP_URL).toBe(url);
      expect(() => parse('ftp://example.uz')).toThrow(/STAFF_WEB_APP_URL/);
      expect(parse('').STAFF_WEB_APP_URL).toBeUndefined();
    });
  });

  describe('TELEGRAM_MINI_APP_URL', () => {
    it('is optional and accepts only an https://t.me/ URL', () => {
      const url = 'https://t.me/iorder_bot/shop';
      expect(parseEnv({ DATABASE_URL: validUrl }).TELEGRAM_MINI_APP_URL).toBeUndefined();
      expect(
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MINI_APP_URL: '' }).TELEGRAM_MINI_APP_URL,
      ).toBeUndefined();
      expect(
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MINI_APP_URL: url }).TELEGRAM_MINI_APP_URL,
      ).toBe(url);
      for (const bad of [
        'http://t.me/bot/app',
        'https://example.com/bot/app',
        'https://t.me.evil.example/bot/app',
        'https://evil.example/https://t.me/',
      ]) {
        expect(() => parseEnv({ DATABASE_URL: validUrl, TELEGRAM_MINI_APP_URL: bad })).toThrow(
          /TELEGRAM_MINI_APP_URL/,
        );
      }
    });
  });

  describe('the staff Mini App settings', () => {
    const main = '111111:main-bot-fake-token';
    const staff = '222222:staff-bot-fake-token';

    it('are off by default: no staff bot and no staff Mini App link', () => {
      const env = parseEnv({ DATABASE_URL: validUrl, BOT_TOKEN: main });
      expect(env.STAFF_MINI_APP_BOT_TOKEN).toBeUndefined();
      expect(env.TELEGRAM_STAFF_MINI_APP_URL).toBeUndefined();
      const empty = parseEnv({
        DATABASE_URL: validUrl,
        BOT_TOKEN: main,
        STAFF_MINI_APP_BOT_TOKEN: '',
        TELEGRAM_STAFF_MINI_APP_URL: '',
      });
      expect(empty.STAFF_MINI_APP_BOT_TOKEN).toBeUndefined();
      expect(empty.TELEGRAM_STAFF_MINI_APP_URL).toBeUndefined();
    });

    it('accepts a second bot, which may be the staff Login Widget bot', () => {
      const env = parseEnv({
        DATABASE_URL: validUrl,
        BOT_TOKEN: main,
        STAFF_LOGIN_BOT_TOKEN: staff,
        STAFF_MINI_APP_BOT_TOKEN: staff,
      });
      expect(env.STAFF_MINI_APP_BOT_TOKEN).toBe(staff);
    });

    it('refuses the main bot as the staff bot, without echoing a token', () => {
      try {
        parseEnv({ DATABASE_URL: validUrl, BOT_TOKEN: main, STAFF_MINI_APP_BOT_TOKEN: main });
        expect.unreachable('parseEnv should have thrown');
      } catch (error) {
        expect(String(error)).toMatch(/STAFF_MINI_APP_BOT_TOKEN: must be a different bot/);
        expect(String(error)).not.toContain(main);
      }
    });

    it('refuses a staff bot without the main bot', () => {
      expect(() => parseEnv({ DATABASE_URL: validUrl, STAFF_MINI_APP_BOT_TOKEN: staff })).toThrow(
        /BOT_TOKEN: required when STAFF_MINI_APP_BOT_TOKEN is set/,
      );
    });

    it('accepts a staff bot webhook secret only with the staff bot and unlike the main one', () => {
      const secret = 'staff-bot-secret_0123456789abcdef';
      const base = { DATABASE_URL: validUrl, BOT_TOKEN: main };
      expect(
        parseEnv({ ...base, STAFF_MINI_APP_BOT_TOKEN: staff, STAFF_BOT_WEBHOOK_SECRET: secret })
          .STAFF_BOT_WEBHOOK_SECRET,
      ).toBe(secret);
      expect(() => parseEnv({ ...base, STAFF_BOT_WEBHOOK_SECRET: secret })).toThrow(
        /STAFF_MINI_APP_BOT_TOKEN: required when STAFF_BOT_WEBHOOK_SECRET is set/,
      );
      expect(() =>
        parseEnv({
          ...base,
          STAFF_MINI_APP_BOT_TOKEN: staff,
          TELEGRAM_WEBHOOK_SECRET: secret,
          STAFF_BOT_WEBHOOK_SECRET: secret,
        }),
      ).toThrow(/STAFF_BOT_WEBHOOK_SECRET: must differ from TELEGRAM_WEBHOOK_SECRET/);
      expect(() =>
        parseEnv({ ...base, STAFF_MINI_APP_BOT_TOKEN: staff, STAFF_BOT_WEBHOOK_SECRET: 'short' }),
      ).toThrow(/STAFF_BOT_WEBHOOK_SECRET/);
    });

    it('accepts only an https://t.me/ link for the staff Mini App', () => {
      const url = 'https://t.me/iorder_staff_bot/staff';
      expect(
        parseEnv({ DATABASE_URL: validUrl, TELEGRAM_STAFF_MINI_APP_URL: url })
          .TELEGRAM_STAFF_MINI_APP_URL,
      ).toBe(url);
      for (const bad of [
        'http://t.me/bot/app',
        'https://dashboard.example.uz/',
        'https://t.me.evil.example/bot/app',
      ]) {
        expect(() =>
          parseEnv({ DATABASE_URL: validUrl, TELEGRAM_STAFF_MINI_APP_URL: bad }),
        ).toThrow(/TELEGRAM_STAFF_MINI_APP_URL/);
      }
    });
  });

  describe('Google Sheets settings', () => {
    const sheetId = 'fake-sheet-id-0123456789';

    it('are all optional; the source counts as configured only with all three', () => {
      const none = parseEnv({ DATABASE_URL: validUrl, GOOGLE_SHEET_ID: '' });
      expect(none.GOOGLE_SHEET_ID).toBeUndefined();
      expect(isSheetSourceConfigured(none)).toBe(false);
      const some = parseEnv({ DATABASE_URL: validUrl, GOOGLE_SHEET_ID: sheetId });
      expect(isSheetSourceConfigured(some)).toBe(false);
      const all = parseEnv({
        DATABASE_URL: validUrl,
        GOOGLE_SHEET_ID: sheetId,
        GOOGLE_SERVICE_ACCOUNT_FILE: 'key.json',
        GOOGLE_SHEET_SUPPLIES_TAB: 'Поставка',
      });
      expect(isSheetSourceConfigured(all)).toBe(true);
    });

    it('rejects a malformed sheet id', () => {
      expect(() => parseEnv({ DATABASE_URL: validUrl, GOOGLE_SHEET_ID: 'https://x/y' })).toThrow(
        /GOOGLE_SHEET_ID/,
      );
    });
  });

  describe('job switches', () => {
    const switches = [
      'JOBS_ENABLED',
      'JOBS_USD_RATE_REFRESH_ENABLED',
      'JOBS_SHEET_SYNC_ENABLED',
      'JOBS_OUTBOX_DISPATCH_ENABLED',
    ] as const;

    it('are all off by default, also when empty', () => {
      for (const raw of [{}, Object.fromEntries(switches.map((name) => [name, '']))]) {
        const env = parseEnv({ DATABASE_URL: validUrl, ...raw });
        for (const name of switches) expect(env[name]).toBe(false);
      }
    });

    it('turn on only with the exact word true', () => {
      for (const name of switches) {
        expect(parseEnv({ DATABASE_URL: validUrl, [name]: 'true' })[name]).toBe(true);
        expect(parseEnv({ DATABASE_URL: validUrl, [name]: 'false' })[name]).toBe(false);
        for (const bad of ['1', 'yes', 'TRUE', 'on']) {
          expect(() => parseEnv({ DATABASE_URL: validUrl, [name]: bad })).toThrow(name);
        }
      }
    });
  });
});
