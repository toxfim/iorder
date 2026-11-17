/** The part of `fetch` this client uses, so tests inject a fake and never touch the network. */
export type HttpFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Token exchange: one small request. */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;
/** The values read of a large sheet can take a while; still bounded. */
export const GOOGLE_SHEETS_TIMEOUT_MS = 60_000;
