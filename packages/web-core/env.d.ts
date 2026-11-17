/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'true' enables the in-memory fake API in a non-dev build (previews/demos only). */
  readonly VITE_USE_FAKE_API?: string;
  /** 'true' on the dev server uses the real api (through the `/api` proxy) instead of the fakes. */
  readonly VITE_USE_REAL_API?: string;
  /**
   * Where the real HTTP clients send requests: `/api` (a same-origin path; the dev server and the
   * production reverse proxy strip the prefix), an absolute origin (then the api needs CORS), or
   * empty (same origin, root paths).
   */
  readonly VITE_API_BASE_URL?: string;
  /** Dev server only: where `/api` is proxied to. Default `http://127.0.0.1:3000`. */
  readonly VITE_DEV_API_PROXY_TARGET?: string;
  /** Bot username (no @) of the Telegram Login Widget on the staff login page. Empty: no widget. */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
  readonly VITE_STAFF_TELEGRAM_BOT_USERNAME?: string;
  /** Bot link (`https://t.me/...`) shown to people who open the app outside Telegram. */
  readonly VITE_TELEGRAM_BOT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
