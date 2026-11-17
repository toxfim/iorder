import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTelegramLink } from './open-telegram-link';

const LINK = 'https://t.me/iorder_bot?start=staff_abc';

afterEach(() => {
  delete (window as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy;
  vi.restoreAllMocks();
});

describe('openTelegramLink', () => {
  it('goes through the Mini App bridge inside Telegram', () => {
    const postEvent = vi.fn();
    (window as { TelegramWebviewProxy?: unknown }).TelegramWebviewProxy = { postEvent };
    expect(openTelegramLink(LINK)).toBe(true);
    expect(postEvent).toHaveBeenCalledWith(
      'web_app_open_tg_link',
      JSON.stringify({ path_full: '/iorder_bot?start=staff_abc' }),
    );
  });

  it('navigates to the link outside Telegram', () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ assign } as unknown as Location);
    expect(openTelegramLink(LINK)).toBe(false);
    expect(assign).toHaveBeenCalledWith(LINK);
  });

  it('refuses anything that is not a t.me link', () => {
    expect(() => openTelegramLink('https://evil.example/t.me/x')).toThrow();
  });
});
