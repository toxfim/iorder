import { onBeforeUnmount, onMounted } from 'vue';
import { onBackButtonPressed, showBackButton } from './mini-app-bridge';

// Telegram draws a back button in its own header. A page that has its own way back (the link
// above a detail page) lends it that action while the page is on screen, so the person does not
// have to reach for a small link at the top of a phone.

// An app switches this on at start-up, and only when Telegram opened it: everywhere else the
// composable below does nothing at all.
let enabled = false;
let subscribed = false;
// The page mounted last decides: a detail page opened over another one wins until it leaves.
const actions: Array<() => void> = [];

function sync(): void {
  showBackButton(actions.length > 0);
}

/** Start-up switch of an app that runs inside Telegram. */
export function enableTelegramBackButton(): void {
  enabled = true;
  if (subscribed) return;
  subscribed = true;
  onBackButtonPressed(() => actions[actions.length - 1]?.());
}

/** Test helper: back to the state of a page opened outside Telegram. */
export function disableTelegramBackButton(): void {
  enabled = false;
  actions.length = 0;
}

/**
 * While the calling component is mounted, Telegram's back button is visible and runs `onBack`.
 * Outside Telegram (or in an app that did not opt in) this is a no-op.
 */
export function useTelegramBackButton(onBack: () => void): void {
  if (!enabled) return;
  onMounted(() => {
    actions.push(onBack);
    sync();
  });
  onBeforeUnmount(() => {
    const index = actions.lastIndexOf(onBack);
    if (index !== -1) actions.splice(index, 1);
    sync();
  });
}
