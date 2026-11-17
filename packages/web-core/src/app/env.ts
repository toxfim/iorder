// Replaced at build time by `define` in vite.config.ts: true for the dev server, tests, or a build
// with VITE_USE_FAKE_API=true; false for a normal production build, which lets the bundler drop
// the dynamic import of the fake adapters (and every demo identity in them).
declare const __FAKE_API__: boolean;

export const FAKE_API_ENABLED: boolean = __FAKE_API__;

const API_BASE_HELP =
  'VITE_API_BASE_URL must be a path starting with "/" (for example /api) or an https:// origin ' +
  '(http:// only for localhost or 127.0.0.1 on the dev server).';

/**
 * Where the real HTTP clients send requests. The default is `/api`, never the empty string: the
 * api's root paths (`/staff/...`) are the SPA's own routes, so same-origin calls need a prefix
 * (the production reverse proxy strips it before forwarding). Anything else than a `/path` or an
 * https origin is a deployment mistake and stops the app at start-up instead of failing later.
 */
export function parseApiBaseUrl(value: string | undefined, dev: boolean): string {
  const raw = (value ?? '').trim();
  if (raw === '') return '/api';
  const fail = (): never => {
    throw new Error(`Invalid VITE_API_BASE_URL "${raw}". ${API_BASE_HELP}`);
  };
  if (raw.startsWith('/')) {
    // "//host" is a protocol-relative URL and "/\\" is read as one by browsers.
    if (raw.startsWith('//') || raw.includes('\\') || /[?#]/.test(raw)) return fail();
    return raw.replace(/\/+$/, '') || '/api';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  const localHttp =
    dev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) return fail();
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return fail();
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export const API_BASE_URL: string = parseApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL,
  import.meta.env.DEV,
);

/**
 * The bot of the Telegram Login Widget on the staff login page. Telegram bot usernames are 5-32
 * characters of letters, digits and underscores; anything else (or nothing) means the widget is
 * not configured and is never loaded. Validated because the value ends up in a script attribute.
 */
export function parseBotUsername(value: string | undefined): string | null {
  const name = (value ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name) ? name : null;
}

export const TELEGRAM_BOT_USERNAME: string | null = parseBotUsername(
  import.meta.env.VITE_TELEGRAM_BOT_USERNAME,
);

/**
 * The bot link shown when the app is opened outside Telegram. Only a https://t.me/ address is
 * used; anything else (or nothing) shows the instruction without a link.
 */
const configuredBotUrl: string = import.meta.env.VITE_TELEGRAM_BOT_URL ?? '';
export const TELEGRAM_BOT_URL: string | null = /^https:\/\/t\.me\/[A-Za-z0-9_/?=.-]+$/.test(
  configuredBotUrl,
)
  ? configuredBotUrl
  : null;
