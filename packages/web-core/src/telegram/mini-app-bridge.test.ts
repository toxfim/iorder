import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  followSafeAreas,
  hapticTap,
  isVersionAtLeast,
  onBackButtonPressed,
  onMiniAppEvent,
  setMiniAppColors,
  showBackButton,
  startMiniApp,
} from './mini-app-bridge';

type ProxyWindow = { TelegramWebviewProxy?: { postEvent: (a: string, b: string) => void } };
type ReceiverWindow = {
  Telegram?: { WebView?: { receiveEvent?: (type: string, data: string) => void } };
  TelegramGameProxy?: { receiveEvent?: (type: string, data: string) => void };
  TelegramGameProxy_receiveEvent?: (type: string, data: string) => void;
};

describe('mini app bridge', () => {
  afterEach(() => {
    delete (window as unknown as ProxyWindow).TelegramWebviewProxy;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.removeProperty(`--tg-safe-${side}`);
      document.documentElement.style.removeProperty(`--tg-content-safe-${side}`);
    }
  });

  function proxy() {
    const postEvent = vi.fn();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    return postEvent;
  }

  /** Delivers an event the way Telegram's native clients do. */
  const fromTelegram = (type: string, data: unknown = ''): void => {
    const target = window as unknown as ReceiverWindow;
    target.Telegram?.WebView?.receiveEvent?.(type, data === '' ? '' : JSON.stringify(data));
  };

  it('compares versions by number', () => {
    expect(isVersionAtLeast('7.10', '7.7')).toBe(true);
    expect(isVersionAtLeast('7.6', '7.7')).toBe(false);
    expect(isVersionAtLeast('8.0', '7.7')).toBe(true);
    expect(isVersionAtLeast(null, '6.1')).toBe(false);
  });

  it('sends ready, expand and the swipe setting on a client that supports it', () => {
    const postEvent = proxy();
    startMiniApp('8.0');
    expect(postEvent.mock.calls).toEqual([
      ['web_app_ready', ''],
      ['web_app_expand', ''],
      ['web_app_setup_swipe_behavior', '{"allow_vertical_swipe":false}'],
    ]);
  });

  it('leaves out what an older client does not know', () => {
    const postEvent = proxy();
    startMiniApp('6.0');
    hapticTap();
    showBackButton(true);
    setMiniAppColors({ header: '#ffffff', background: '#f6f7f9' });
    followSafeAreas();
    expect(postEvent.mock.calls.map((call) => call[0])).toEqual([
      'web_app_ready',
      'web_app_expand',
    ]);
  });

  it('does nothing outside Telegram', () => {
    expect(() => startMiniApp(null)).not.toThrow();
    expect(() => showBackButton(true)).not.toThrow();
    expect(() => followSafeAreas()).not.toThrow();
  });

  describe('events from Telegram', () => {
    it('shows the back button and reports a press through every delivery path Telegram uses', () => {
      const postEvent = proxy();
      startMiniApp('8.0');
      postEvent.mockClear();
      const pressed = vi.fn();
      const stop = onBackButtonPressed(pressed);

      showBackButton(true);
      expect(postEvent.mock.calls).toEqual([['web_app_setup_back_button', '{"is_visible":true}']]);

      const target = window as unknown as ReceiverWindow;
      target.Telegram?.WebView?.receiveEvent?.('back_button_pressed', '');
      target.TelegramGameProxy?.receiveEvent?.('back_button_pressed', '');
      target.TelegramGameProxy_receiveEvent?.('back_button_pressed', '');
      expect(pressed).toHaveBeenCalledTimes(3);

      stop();
      fromTelegram('back_button_pressed');
      expect(pressed).toHaveBeenCalledTimes(3);
    });

    it('accepts the web client only from its own origin', () => {
      const seen = vi.fn();
      const stop = onMiniAppEvent('back_button_pressed', seen);
      const message = JSON.stringify({ eventType: 'back_button_pressed', eventData: '' });
      window.dispatchEvent(
        new MessageEvent('message', { data: message, origin: 'https://evil.example' }),
      );
      expect(seen).not.toHaveBeenCalled();
      window.dispatchEvent(
        new MessageEvent('message', { data: message, origin: 'https://web.telegram.org' }),
      );
      expect(seen).toHaveBeenCalledTimes(1);
      window.dispatchEvent(
        new MessageEvent('message', { data: 'not json', origin: 'https://web.telegram.org' }),
      );
      expect(seen).toHaveBeenCalledTimes(1);
      stop();
    });

    it('asks for the safe areas and keeps them in CSS variables', () => {
      const postEvent = proxy();
      startMiniApp('8.0');
      postEvent.mockClear();
      followSafeAreas();
      expect(postEvent.mock.calls.map((call) => call[0])).toEqual([
        'web_app_request_safe_area',
        'web_app_request_content_safe_area',
      ]);

      fromTelegram('safe_area_changed', { top: 47, bottom: 34, left: 0, right: 0 });
      fromTelegram('content_safe_area_changed', { top: 46, bottom: 0, left: 0, right: 0 });
      const style = document.documentElement.style;
      expect(style.getPropertyValue('--tg-safe-top')).toBe('47px');
      expect(style.getPropertyValue('--tg-safe-bottom')).toBe('34px');
      expect(style.getPropertyValue('--tg-content-safe-top')).toBe('46px');

      // Values that are not sizes change nothing.
      fromTelegram('safe_area_changed', { top: 'calc(1px)', bottom: -5, left: 9999 });
      expect(style.getPropertyValue('--tg-safe-top')).toBe('47px');
      expect(style.getPropertyValue('--tg-safe-bottom')).toBe('34px');
      expect(style.getPropertyValue('--tg-safe-left')).toBe('0px');
    });
  });

  it('paints Telegram in the colours of the app, and only with #rrggbb values', () => {
    const postEvent = proxy();
    startMiniApp('8.0');
    postEvent.mockClear();
    setMiniAppColors({ header: '#171a1f', background: '#0f1115' });
    expect(postEvent.mock.calls).toEqual([
      ['web_app_set_header_color', '{"color":"#171a1f"}'],
      ['web_app_set_background_color', '{"color":"#0f1115"}'],
      ['web_app_set_bottom_bar_color', '{"color":"#0f1115"}'],
    ]);
    postEvent.mockClear();
    setMiniAppColors({ header: 'red', background: 'var(--page)' });
    expect(postEvent).not.toHaveBeenCalled();
  });
});
