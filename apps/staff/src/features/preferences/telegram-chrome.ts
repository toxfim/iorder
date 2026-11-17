import { setMiniAppColors } from '@core/telegram/mini-app-bridge';

/**
 * Inside Telegram the app follows its OWN light or dark setting (it does not take Telegram's
 * theme), so Telegram's header and the area behind the page are painted in the app's colours:
 * the header like the top bar (`--w`), the rest like the page (`--page`). Read from the tokens
 * as the browser resolved them, so no colour lives here. Outside Telegram nothing is sent.
 */
export function syncTelegramChrome(): void {
  const style = getComputedStyle(document.documentElement);
  setMiniAppColors({
    header: style.getPropertyValue('--w').trim(),
    background: style.getPropertyValue('--page').trim(),
  });
}
