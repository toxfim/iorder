// Opens a `https://t.me/...` link. Inside a Telegram Mini App a plain navigation may leave
// Telegram (or do nothing), so the link goes through Telegram's own Mini App bridge, the
// `web_app_open_tg_link` event, without loading telegram-web-app.js (no third-party script,
// see launch.ts). Outside Telegram it is an ordinary navigation to the link.

interface TelegramWebviewProxy {
  postEvent: (eventType: string, eventData: string) => void;
}

const T_ME = 'https://t.me/';

/** True when the link went through the Mini App bridge, false when the page navigated to it. */
export function openTelegramLink(url: string): boolean {
  if (!url.startsWith(T_ME)) throw new Error('Only https://t.me/ links can be opened here');
  const proxy = (window as Window & { TelegramWebviewProxy?: TelegramWebviewProxy })
    .TelegramWebviewProxy;
  if (proxy && typeof proxy.postEvent === 'function') {
    // The bridge takes the part after t.me, starting with "/".
    proxy.postEvent(
      'web_app_open_tg_link',
      JSON.stringify({ path_full: `/${url.slice(T_ME.length)}` }),
    );
    return true;
  }
  window.location.assign(url);
  return false;
}
