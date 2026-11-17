import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { GOOGLE_TOKEN_TIMEOUT_MS, type HttpFetch } from './http.js';
import { SheetReadError } from './sheet-read-error.js';
import type { KeyReader } from './service-account-key.js';

/** Read-only by construction (hard rule 10): this scope cannot write to a sheet. */
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** The signed assertion is valid for the maximum Google allows. */
export const ASSERTION_LIFETIME_SECONDS = 3600;
/** A cached token is renewed this long before it expires, so a request never carries a stale one. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().toLowerCase().pipe(z.literal('bearer')),
});

const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** Builds the signed RS256 assertion. Exported for the test that verifies it with the public key. */
export function buildAssertion(
  key: { clientEmail: string; privateKey: string },
  nowMs: number,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: key.clientEmail,
      scope: SHEETS_READONLY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    }),
  );
  const unsigned = `${header}.${claims}`;
  let signature: Buffer;
  try {
    signature = sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(key.privateKey));
  } catch {
    // The crypto error text can describe the key material; only the kind survives.
    throw new SheetReadError('AUTH');
  }
  return `${unsigned}.${base64Url(signature)}`;
}

/**
 * Exchanges the service account assertion for an access token and caches it until shortly before
 * it expires. One exchange at a time: concurrent callers share the request in flight. The token
 * and the key are never logged and never appear in an error.
 */
export class GoogleTokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly readKey: KeyReader,
    private readonly fetchImpl: HttpFetch,
    private readonly nowMs: () => number,
    private readonly timeoutMs: number = GOOGLE_TOKEN_TIMEOUT_MS,
  ) {}

  getAccessToken(): Promise<string> {
    const cached = this.cached;
    if (cached && this.nowMs() < cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS) {
      return Promise.resolve(cached.token);
    }
    this.inFlight ??= this.exchange().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Drops the cached token, e.g. after Google answered 401 to it (revoked or expired early). */
  invalidate(): void {
    this.cached = null;
  }

  private async exchange(): Promise<string> {
    const requestedAtMs = this.nowMs();
    const assertion = buildAssertion(await this.readKey(), requestedAtMs);
    let response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SheetReadError('NETWORK');
    }
    if (response.status === 429) throw new SheetReadError('QUOTA');
    if (response.status >= 500) throw new SheetReadError('NETWORK');
    if (response.status !== 200) throw new SheetReadError('AUTH');

    let parsed;
    try {
      parsed = tokenResponseSchema.parse(JSON.parse(await response.text()));
    } catch {
      throw new SheetReadError('MALFORMED');
    }
    this.cached = {
      token: parsed.access_token,
      expiresAtMs: requestedAtMs + parsed.expires_in * 1000,
    };
    return parsed.access_token;
  }
}
