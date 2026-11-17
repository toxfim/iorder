import { captureLaunchParams, isTelegramLaunch, readClientVersion } from '@core/telegram/launch';
import { followSafeAreas, startMiniApp } from '@core/telegram/mini-app-bridge';
import { enableTelegramBackButton } from '@core/telegram/use-back-button';

/**
 * Start-up inside Telegram (the staff app is also a Mini App). Runs before the router exists:
 * reads the launch parameters out of the URL fragment, tells Telegram the app is ready, follows
 * its safe areas and back button, and moves to the page a direct link asked for. In an ordinary
 * browser tab only the fragment read happens (it finds nothing). Returns whether Telegram opened
 * this tab.
 */
export async function prepareTelegramLaunch(): Promise<boolean> {
  captureLaunchParams();
  if (!isTelegramLaunch()) return false;
  // Marks the document for the few styles that differ under Telegram's own header.
  document.documentElement.setAttribute('data-telegram', '');
  startMiniApp(readClientVersion());
  followSafeAreas();
  enableTelegramBackButton();
  // Lazy on purpose: the page paths of the staff area stay out of the entry chunk.
  const { openStartPage } = await import('@/features/staff-auth/telegram-start');
  openStartPage();
  return true;
}
