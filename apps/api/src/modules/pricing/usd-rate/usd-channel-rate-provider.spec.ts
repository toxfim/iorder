import { describe, expect, it } from 'vitest';
import { RateProviderError } from './usd-rate-provider.js';
import {
  CHANNEL_URL,
  parseChannelPage,
  TelegramChannelRateProvider,
  type FetchTextLike,
} from './usd-channel-rate-provider.js';

// The shape of the real page, kept from the read-only request of 2026-10-31.
const post = (id: number, text: string): string =>
  `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="wasuntechnology/${String(id)}" data-view="x">` +
  `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
  `<div class="tgme_widget_message_footer"><time datetime="2026-10-28T06:19:53+00:00"></time></div></div></div>`;
const daily = (rate: string, date: string): string =>
  `Assalomu aleykum.<br/>Bugungi kurs: ${rate}<br/><br/>Sana : ${date}<br/>Kurs kun davomida ozgarmaydi&#33;&#33;&#33;`;

describe('parseChannelPage', () => {
  it('reads the rate and the day the post names', () => {
    expect(parseChannelPage(post(557, daily('11960', '28.10.2026')))).toEqual([
      { rate: '11960', rateDate: '2026-10-28', postId: 557 },
    ]);
  });

  it('ignores other posts and keeps the rate posts around them', () => {
    const page =
      post(555, daily('11880', '26.10.2026')) +
      post(556, 'Narx oshdi &#33;&#33;&#33;') +
      post(557, daily('11900', '27.10.2026'));
    expect(parseChannelPage(page).map((q) => q.postId)).toEqual([555, 557]);
  });

  it('accepts a thousands separator in the rate', () => {
    for (const rate of ['11 960', '11,960', '11.960']) {
      expect(parseChannelPage(post(1, daily(rate, '28.10.2026')))[0]?.rate).toBe('11960');
    }
  });

  it.each([
    ['no date line', 'Bugungi kurs: 11960'],
    ['no rate line', 'Sana : 28.10.2026'],
    ['a rate with words after it', daily('11960 dan', '28.10.2026')],
    ['a decimal rate', daily('11960.5', '28.10.2026')],
    ['an impossible date', daily('11960', '31.02.2026')],
    ['a rate only mentioned in a sentence', 'Bugungi kurs 11960 emas<br/>Sana : 28.10.2026'],
  ])('never guesses: %s', (_name, text) => {
    expect(parseChannelPage(post(1, text))).toEqual([]);
  });

  it('a post without any text (a photo) is skipped', () => {
    const page = `<div data-post="wasuntechnology/9"><div class="tgme_widget_message_photo"></div></div>`;
    expect(parseChannelPage(page)).toEqual([]);
  });

  it("does not take another channel's post", () => {
    const foreign = post(1, daily('11960', '28.10.2026')).replace('wasuntechnology', 'other');
    expect(() => parseChannelPage(foreign)).toThrow(RateProviderError);
  });

  it('a page with no posts is an error, not "no rate today"', () => {
    expect(() => parseChannelPage('<html>changed layout</html>')).toThrow(RateProviderError);
  });
});

describe('TelegramChannelRateProvider', () => {
  const kindOf = async (fetchImpl: FetchTextLike): Promise<unknown> => {
    const failure: unknown = await new TelegramChannelRateProvider(fetchImpl)
      .fetchRecentQuotes()
      .catch((error: unknown) => error);
    return failure instanceof RateProviderError ? failure.kind : failure;
  };

  it('asks the public page and returns its quotes', async () => {
    const urls: string[] = [];
    const quotes = await new TelegramChannelRateProvider((url) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(post(7, daily('11960', '28.10.2026'))),
      });
    }).fetchRecentQuotes();
    expect(urls).toEqual([CHANNEL_URL]);
    expect(quotes).toHaveLength(1);
  });

  it('reports only the kind of a failure', async () => {
    await expect(kindOf(() => Promise.reject(new Error('secret detail')))).resolves.toBe(
      'UNREACHABLE',
    );
    await expect(
      kindOf(() => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('') })),
    ).resolves.toBe('HTTP_STATUS');
    await expect(
      kindOf(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('x') })),
    ).resolves.toBe('BAD_RESPONSE');
  });
});
