import { isAbsolute } from 'node:path';
import { DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS } from '@iorder/shared';
import { z } from 'zod';

// An empty value in .env (`BOT_TOKEN=`) means "not configured".
const emptyAsUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

// A feature switch: only the exact words `true` / `false` (an empty value means off). Anything
// else, such as `yes` or `1`, is an error, so a typo can never switch a background job on.
const flag = z
  .preprocess(emptyAsUndefined, z.enum(['true', 'false']).default('false'))
  .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z
      .string()
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'must be a PostgreSQL connection URL',
      ),
    // Without a token the app has no actor resolver and rejects every protected request (fails
    // closed). There is no development bypass. A secret: never logged, never echoed in errors.
    BOT_TOKEN: z.preprocess(
      emptyAsUndefined,
      z.string().min(10).regex(/^\S+$/, 'must not contain whitespace').optional(),
    ),
    // The bot of the Telegram Login Widget on the STAFF website, when it is not BOT_TOKEN's bot.
    // Telegram allows one widget domain per bot, so the customer site (order.*) and the staff site
    // (dashboard.*) need two bots. This one only signs staff in: notifications, groups and the
    // Mini App stay on BOT_TOKEN's bot (the Telegram user id is the same in every bot). Unset:
    // the staff widget is verified with BOT_TOKEN, as before. A secret, like BOT_TOKEN.
    STAFF_LOGIN_BOT_TOKEN: z.preprocess(
      emptyAsUndefined,
      z.string().min(10).regex(/^\S+$/, 'must not contain whitespace').optional(),
    ),
    // The bot that hosts the STAFF Mini App, when it is not BOT_TOKEN's bot (optional, off by
    // default). One bot signing the init data of both Mini Apps means the init data the customer
    // app holds for a staff member also opens /staff routes. With this set, only init data signed
    // by THIS bot makes a staff actor; init data signed by BOT_TOKEN's bot makes a customer member
    // or a staff viewer, never a staff actor, on any route. It may be the same bot as
    // STAFF_LOGIN_BOT_TOKEN (one staff bot for the Login Widget and the Mini App), never the same
    // as BOT_TOKEN (checked below). Unset: BOT_TOKEN's bot signs both, as before. A secret.
    STAFF_MINI_APP_BOT_TOKEN: z.preprocess(
      emptyAsUndefined,
      z.string().min(10).regex(/^\S+$/, 'must not contain whitespace').optional(),
    ),
    // A Mini App session keeps the same signed init data while it stays open, so a short limit
    // would log people out mid-session. Default 24 hours, at most 7 days.
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(604_800).default(86_400),
    ),
    // Website sessions of staff and customers (see modules/identity/staff-auth.settings.ts for the
    // defaults: 14 days idle [C, 2026-11-09], 90 days absolute [P]; Login Widget proof 5 minutes).
    // Unset = the default; at most 180 days. A value here REPLACES the default, so a server that
    // still carries an old short limit keeps asking people to sign in.
    STAFF_SESSION_IDLE_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(60).max(15_552_000).optional(),
    ),
    STAFF_SESSION_ABSOLUTE_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(300).max(15_552_000).optional(),
    ),
    TELEGRAM_LOGIN_MAX_AGE_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(30).max(3600).optional(),
    ),
    // How long after submitting a customer may still change the payment plan (owner 2026-10-30:
    // 3 minutes, see modules/orders/payment-plan.settings.ts). Unset = the default.
    PAYMENT_PLAN_CHANGE_WINDOW_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(86_400).optional(),
    ),
    // Staff members may open the customer app as viewers ([C] 2026-11-09). They can place an order
    // ONLY where this names an organization: the order is then written to that one test
    // organization. STAGING ONLY; production leaves it empty, and a staff order is then refused
    // by the server. An id that names no ACTIVE organization also refuses (checked at use, with
    // no fallback to any other organization).
    STAFF_ORDERING_ORGANIZATION_ID: z.preprocess(emptyAsUndefined, z.uuid().optional()),
    // Which deployed installation this is. Staging and production both run NODE_ENV=production,
    // so without this the api cannot tell them apart. Unset means production (the most
    // restrictive reading). Its one use today: the staff ordering line above is refused at boot
    // unless the installation says it is staging (checked below).
    APP_ENVIRONMENT: z.preprocess(emptyAsUndefined, z.enum(['staging', 'production']).optional()),
    // The bot runtime is OFF unless this is set on purpose. `polling` is for the owner's manual dev
    // run (`pnpm --filter @iorder/api bot:polling`), `webhook` opens POST /telegram/webhook/:secret.
    // Both need BOT_TOKEN; `webhook` also needs TELEGRAM_WEBHOOK_SECRET (checked below).
    TELEGRAM_MODE: z.preprocess(
      emptyAsUndefined,
      z.enum(['off', 'polling', 'webhook']).default('off'),
    ),
    // Proposed anti-spam budgets, configurable until the owner confirms the operational limits.
    TELEGRAM_PENDING_NOTICES_PER_ADDER_PER_HOUR: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(100_000).default(5),
    ),
    TELEGRAM_PENDING_NOTICES_PER_HOUR: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(100_000).default(20),
    ),
    // How long a staff-created organization's bot invite link works [P]: 7 days by default,
    // from 10 minutes to 90 days.
    ORGANIZATION_INVITE_TTL_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce
        .number()
        .int()
        .min(600)
        .max(90 * 24 * 60 * 60)
        .default(DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS),
    ),
    // Telegram's own `secret_token` alphabet (A-Z a-z 0-9 _ -), 16 to 256 characters. A secret:
    // compared in constant time, never logged.
    TELEGRAM_WEBHOOK_SECRET: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 characters of A-Z a-z 0-9 _ -')
        .optional(),
    ),
    // The webhook secret of the STAFF bot (STAFF_MINI_APP_BOT_TOKEN), which answers `/start` in
    // its private chat with a greeting and two buttons to the staff app. Same alphabet as
    // TELEGRAM_WEBHOOK_SECRET and a different value. Unset: the staff bot's route answers 404 and
    // the bot stays silent, as before. A secret: compared in constant time, never logged.
    STAFF_BOT_WEBHOOK_SECRET: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/, 'must be 16-256 characters of A-Z a-z 0-9 _ -')
        .optional(),
    ),
    // Reverse proxies in FRONT of the api (0 = none, the default: request.ip is the socket address).
    // Behind a proxy it must equal the number of proxy hops, otherwise every client shares the
    // proxy's address and the sign-in throttles lock everybody out together (or, set too high, a
    // client can forge its address with X-Forwarded-For). Go-live gate; see production-db-roles.md.
    TRUST_PROXY: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(0).max(5).default(0)),
    // Base URL of the customer web app, used in bot messages (links to prices and orders).
    WEB_APP_URL: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .url()
        .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL')
        .optional(),
    ),
    // Base URL of the staff web app for staff links in bot messages (ADR-001 3.5). Optional: without
    // it staff links use WEB_APP_URL (both apps on one origin).
    STAFF_WEB_APP_URL: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .url()
        .refine((value) => /^https?:\/\//.test(value), 'must be an http(s) URL')
        .optional(),
    ),
    // Direct link of the Telegram Mini App (https://t.me/<bot>/<app>), used for the button under
    // the `/price` Excel file. Only https://t.me/ links are accepted. A `url` button works in
    // groups too (`web_app` buttons are private-chat only). Optional: without it no button.
    TELEGRAM_MINI_APP_URL: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .url()
        .regex(/^https:\/\/t\.me\//, 'must be an https://t.me/ URL')
        .optional(),
    ),
    // Direct link of the STAFF Mini App (https://t.me/<bot>/<app>, BotFather /newapp with the
    // staff app's address): the "Open in the Mini App" button under a staff notification opens it
    // with ?startapp=order_<order id>. The link must belong to the bot whose token verifies staff
    // init data (STAFF_MINI_APP_BOT_TOKEN when set, otherwise BOT_TOKEN). Optional: without it
    // the button is a `web_app` button of BOT_TOKEN's bot, or absent when that bot may not sign
    // staff in (modules/telegram/web-links.ts).
    TELEGRAM_STAFF_MINI_APP_URL: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .url()
        .regex(/^https:\/\/t\.me\//, 'must be an https://t.me/ URL')
        .optional(),
    ),
    // Google Sheets, READ-ONLY (hard rule 10). The real source is used only when all three are set;
    // otherwise the sync fails loudly as "not configured". The key file is read lazily, on the first
    // sync, and its content is never logged. The key path and sheet id are not secrets themselves.
    GOOGLE_SERVICE_ACCOUNT_FILE: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    GOOGLE_SHEET_ID: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{10,200}$/, 'must be the spreadsheet id (A-Z a-z 0-9 _ -)')
        .optional(),
    ),
    GOOGLE_SHEET_SUPPLIES_TAB: z.preprocess(
      emptyAsUndefined,
      z.string().min(1).max(100).optional(),
    ),
    // Folder for uploaded files (product photos under `product-images/`), an absolute path on the
    // server (a Docker volume, see deploy/compose.app.yml). Unset in development = `<repo>/.media`
    // (git-ignored); required in production so photos never land inside the container.
    MEDIA_DIR: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .refine((value) => isAbsolute(value), 'must be an absolute path')
        .optional(),
    ),
    // Background jobs (pg-boss), run ONLY by the separate worker process (`pnpm ... worker`).
    // Everything is off by default; a job schedules only when JOBS_ENABLED and its own flag are true.
    JOBS_ENABLED: flag,
    JOBS_USD_RATE_REFRESH_ENABLED: flag,
    JOBS_SHEET_SYNC_ENABLED: flag,
    JOBS_OUTBOX_DISPATCH_ENABLED: flag,
    // Daily price list post to the organization groups, 09:00 Tashkent [P]. Sent by the outbox job.
    JOBS_PRICE_POST_ENABLED: flag,
    // DEVELOPER_TELEGRAM_ID is deliberately NOT here: only `seed:admin` reads and validates it, so
    // a typo in it can never stop the API from booting.
  })
  .superRefine((env, context) => {
    if (env.TELEGRAM_MODE !== 'off' && env.BOT_TOKEN === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_TOKEN'],
        message: 'required when TELEGRAM_MODE is not off',
      });
    }
    // The staff bot only ADDS a second door: the customer app and everything else stay on
    // BOT_TOKEN. The same token twice would make the binding meaningless, so it is refused
    // instead of silently ignored.
    if (env.STAFF_MINI_APP_BOT_TOKEN !== undefined && env.BOT_TOKEN === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_TOKEN'],
        message: 'required when STAFF_MINI_APP_BOT_TOKEN is set',
      });
    }
    if (
      env.STAFF_MINI_APP_BOT_TOKEN !== undefined &&
      env.STAFF_MINI_APP_BOT_TOKEN === env.BOT_TOKEN
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STAFF_MINI_APP_BOT_TOKEN'],
        message: 'must be a different bot than BOT_TOKEN (leave it empty to use one bot)',
      });
    }
    // The staff bot's webhook belongs to the staff bot: without its token nothing could answer.
    if (env.STAFF_BOT_WEBHOOK_SECRET !== undefined && env.STAFF_MINI_APP_BOT_TOKEN === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['STAFF_MINI_APP_BOT_TOKEN'],
        message: 'required when STAFF_BOT_WEBHOOK_SECRET is set',
      });
    }
    // One secret for both bots would let a request for one route pass the other's check.
    if (
      env.STAFF_BOT_WEBHOOK_SECRET !== undefined &&
      env.STAFF_BOT_WEBHOOK_SECRET === env.TELEGRAM_WEBHOOK_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STAFF_BOT_WEBHOOK_SECRET'],
        message: 'must differ from TELEGRAM_WEBHOOK_SECRET',
      });
    }
    if (env.TELEGRAM_MODE === 'webhook' && env.TELEGRAM_WEBHOOK_SECRET === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'required when TELEGRAM_MODE is webhook',
      });
    }
    // Production always sits behind a reverse proxy (deploy/apache). With TRUST_PROXY=0 every
    // client would share the proxy's address, and one attacker could lock every sign-in out.
    // Refusing to boot makes a forgotten value visible; no opt-out, because the deployment has
    // no proxy-less variant.
    // A staff order must be impossible in production [C, 2026-11-09]. The id check at use already
    // refuses an organization this database does not have (a line copied from staging), but a
    // production organization's id typed here would switch staff ordering on with nobody noticing.
    // Refusing to boot makes that visible at once. Development and test runs are not deployed
    // installations and need no marker.
    if (
      env.NODE_ENV === 'production' &&
      env.STAFF_ORDERING_ORGANIZATION_ID !== undefined &&
      env.APP_ENVIRONMENT !== 'staging'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STAFF_ORDERING_ORGANIZATION_ID'],
        message: 'allowed only with APP_ENVIRONMENT=staging; production must leave it empty',
      });
    }
    if (env.NODE_ENV === 'production' && env.MEDIA_DIR === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['MEDIA_DIR'],
        message: 'required in production (the folder of uploaded product photos)',
      });
    }
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY === 0) {
      context.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'must be the number of reverse proxy hops (at least 1) in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** The real Google Sheets source needs all three settings; with fewer the source stays unconfigured. */
export function isSheetSourceConfigured(
  env: Pick<Env, 'GOOGLE_SERVICE_ACCOUNT_FILE' | 'GOOGLE_SHEET_ID' | 'GOOGLE_SHEET_SUPPLIES_TAB'>,
): boolean {
  return (
    env.GOOGLE_SERVICE_ACCOUNT_FILE !== undefined &&
    env.GOOGLE_SHEET_ID !== undefined &&
    env.GOOGLE_SHEET_SUPPLIES_TAB !== undefined
  );
}

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Only names and reasons: values may be secrets and must never reach logs.
    const problems = result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
