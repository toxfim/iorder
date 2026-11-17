import { toIsoDate } from './cbu-usd-rate-provider.js';
import { RateProviderError } from './usd-rate-provider.js';

/** One daily rate post of the channel. */
export interface ChannelRateQuote {
  /** UZS per 1 USD, whole so'm as a decimal string. */
  rate: string;
  /** The day the post itself names (`Sana`), ISO `YYYY-MM-DD`; never the time it was posted. */
  rateDate: string;
  /** The channel's post number: a higher one is a later post. */
  postId: number;
}

/** The channel's recent rate posts. READ-ONLY, one method; tests use a fake and no network. */
export abstract class UsdChannelRateProvider {
  abstract fetchRecentQuotes(): Promise<ChannelRateQuote[]>;
}

// The channel's public web preview, needing neither a bot in the channel nor a dependency. VERIFIED
// on 2026-10-31 with one read-only request (HTTP 200, also from the staging server). A post looks like:
//
//   <div class="tgme_widget_message_wrap ..."><div ... data-post="wasuntechnology/557" ...>
//     <div class="tgme_widget_message_text js-message_text" dir="auto">Assalomu aleykum.<br/>
//     Bugungi kurs: 11960<br/><br/>Sana : 28.10.2026<br/>Kurs kun davomida ozgarmaydi&#33;&#33;&#33;</div>
export const CHANNEL_NAME = 'wasuntechnology';
export const CHANNEL_URL = `https://t.me/s/${CHANNEL_NAME}`;

/** One attempt, no retries: the next tick of the job tries again. */
export const CHANNEL_TIMEOUT_MS = 10_000;

const POST_START = new RegExp(`data-post="${CHANNEL_NAME}/(\\d+)"`, 'g');
const POST_TEXT = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const RATE_LINE = /^\s*Bugungi\s+kurs\s*:\s*(\d{1,3}(?:[ .,]\d{3})+|\d+)\s*$/im;
const DATE_LINE = /^\s*Sana\s*:\s*(\d{2}\.\d{2}\.\d{4})\s*$/im;

/**
 * The rate posts in a page. A post that does not have BOTH lines in the exact form is ignored ("Narx
 * oshdi !!!" is not a rate), a guess here would price every order. A page with no posts at all means
 * the layout changed or the channel is gone: that is an error, not "no rate today".
 */
export function parseChannelPage(html: string): ChannelRateQuote[] {
  const starts = [...html.matchAll(POST_START)];
  if (starts.length === 0) throw new RateProviderError('BAD_RESPONSE');
  const quotes: ChannelRateQuote[] = [];
  starts.forEach((start, index) => {
    const body = html.slice(start.index, starts[index + 1]?.index ?? html.length);
    const text = POST_TEXT.exec(body)?.[1]?.replace(/<br\s*\/?>/g, '\n');
    if (text === undefined) return;
    const rate = RATE_LINE.exec(text)?.[1]?.replace(/[ .,]/g, '');
    const date = DATE_LINE.exec(text)?.[1];
    const rateDate = date === undefined ? null : toIsoDate(date);
    if (rate === undefined || rateDate === null) return;
    quotes.push({ rate, rateDate, postId: Number(start[1]) });
  });
  return quotes;
}

export type FetchTextLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Real implementation over the built-in fetch (injected, so tests never use the network). */
export class TelegramChannelRateProvider extends UsdChannelRateProvider {
  constructor(
    private readonly fetchImpl: FetchTextLike,
    private readonly options: { url?: string; timeoutMs?: number } = {},
  ) {
    super();
  }

  async fetchRecentQuotes(): Promise<ChannelRateQuote[]> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? CHANNEL_TIMEOUT_MS);
    let html: string;
    let ok: boolean;
    try {
      const response = await this.fetchImpl(this.options.url ?? CHANNEL_URL, { signal });
      ok = response.ok;
      html = ok ? await response.text() : '';
    } catch (error) {
      // Only the KIND of failure survives; the underlying error text is dropped on purpose.
      const timedOut = signal.aborted || (error instanceof Error && error.name === 'TimeoutError');
      throw new RateProviderError(timedOut ? 'TIMEOUT' : 'UNREACHABLE');
    }
    if (!ok) throw new RateProviderError('HTTP_STATUS');
    return parseChannelPage(html);
  }
}
