// Telegram's Mini App bridge without telegram-web-app.js (no third-party script, see launch.ts).
// Events: https://core.telegram.org/api/web-events . Outside Telegram every call does nothing.

interface BridgeWindow {
  TelegramWebviewProxy?: { postEvent: (eventType: string, eventData: string) => void };
  external?: { notify?: (message: string) => void };
}

type Receiver = (eventType: unknown, eventData: unknown) => void;

// The globals Telegram's native clients call to deliver an event (telegram-web-app.js defines
// the same names; this file takes its place).
interface ReceiverWindow {
  Telegram?: { WebView?: { receiveEvent?: Receiver } };
  TelegramGameProxy?: { receiveEvent?: Receiver };
  TelegramGameProxy_receiveEvent?: Receiver;
}

const WEB_CLIENT_ORIGIN = 'https://web.telegram.org';
const SWIPE_SETTING_SINCE = '7.7';
const HAPTICS_SINCE = '6.1';
const BACK_BUTTON_SINCE = '6.1';
const COLORS_SINCE = '6.9';
const BOTTOM_BAR_SINCE = '7.10';
const SAFE_AREA_SINCE = '8.0';

let clientVersion: string | null = null;

function post(eventType: string, data?: Record<string, unknown>): void {
  const eventData = data === undefined ? '' : JSON.stringify(data);
  const bridge = window as unknown as BridgeWindow;
  if (typeof bridge.TelegramWebviewProxy?.postEvent === 'function') {
    bridge.TelegramWebviewProxy.postEvent(eventType, eventData);
  } else if (typeof bridge.external?.notify === 'function') {
    bridge.external.notify(JSON.stringify({ eventType, eventData }));
  } else if (window.parent !== window) {
    window.parent.postMessage(JSON.stringify({ eventType, eventData }), WEB_CLIENT_ORIGIN);
  }
}

/** Compares dotted versions such as `7.10` and `7.7` by number, not as text. */
export function isVersionAtLeast(version: string | null, wanted: string): boolean {
  if (version === null) return false;
  const have = version.split('.').map(Number);
  const need = wanted.split('.').map(Number);
  for (let i = 0; i < need.length; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Tells Telegram the app is ready, opens it at full height and stops a downward drag of the page
 * from collapsing the sheet: while the sheet moves, everything pinned to the bottom moves with it.
 */
export function startMiniApp(version: string | null): void {
  clientVersion = version;
  post('web_app_ready');
  post('web_app_expand');
  if (isVersionAtLeast(version, SWIPE_SETTING_SINCE)) {
    post('web_app_setup_swipe_behavior', { allow_vertical_swipe: false });
  }
}

export function hapticTap(): void {
  if (isVersionAtLeast(clientVersion, HAPTICS_SINCE)) {
    post('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: 'light' });
  }
}

export function hapticSuccess(): void {
  if (isVersionAtLeast(clientVersion, HAPTICS_SINCE)) {
    post('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: 'success' });
  }
}

// ----------------------------------------------------------------------------------------------
// Events from Telegram. They only shape the screen (a back press, the safe areas); nothing that
// arrives here is trusted for a decision about data or access.
// ----------------------------------------------------------------------------------------------

type EventHandler = (data: unknown) => void;

const handlers = new Map<string, Set<EventHandler>>();
let receiving = false;

function receive(eventType: unknown, eventData: unknown): void {
  if (typeof eventType !== 'string') return;
  let data: unknown = eventData;
  if (typeof eventData === 'string' && eventData !== '') {
    try {
      data = JSON.parse(eventData);
    } catch {
      return;
    }
  }
  for (const handler of [...(handlers.get(eventType) ?? [])]) handler(data);
}

function startReceiving(): void {
  if (receiving) return;
  receiving = true;
  const target = window as unknown as ReceiverWindow;
  target.Telegram = {
    ...target.Telegram,
    WebView: { ...target.Telegram?.WebView, receiveEvent: receive },
  };
  target.TelegramGameProxy = { ...target.TelegramGameProxy, receiveEvent: receive };
  target.TelegramGameProxy_receiveEvent = receive;
  // Telegram's web client frames the app and talks to it with postMessage.
  window.addEventListener('message', (event) => {
    if (event.origin !== WEB_CLIENT_ORIGIN || typeof event.data !== 'string') return;
    try {
      const message: unknown = JSON.parse(event.data);
      if (typeof message !== 'object' || message === null) return;
      const { eventType, eventData } = message as { eventType?: unknown; eventData?: unknown };
      receive(eventType, eventData);
    } catch {
      // Not a Telegram event.
    }
  });
}

/** Subscribes to one Telegram event; returns the unsubscribe function. */
export function onMiniAppEvent(eventType: string, handler: EventHandler): () => void {
  startReceiving();
  const set = handlers.get(eventType) ?? new Set<EventHandler>();
  handlers.set(eventType, set);
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}

/** Shows or hides the back button Telegram draws in its own header. */
export function showBackButton(visible: boolean): void {
  if (isVersionAtLeast(clientVersion, BACK_BUTTON_SINCE)) {
    post('web_app_setup_back_button', { is_visible: visible });
  }
}

/** The person pressed Telegram's back button. */
export function onBackButtonPressed(handler: () => void): () => void {
  return onMiniAppEvent('back_button_pressed', () => handler());
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Paints Telegram's own header, the area behind the page and its bottom bar in the app's colours,
 * so the app's light or dark theme does not sit inside a frame of the other one. Only `#rrggbb`
 * values are sent; anything else leaves Telegram's colours as they are.
 */
export function setMiniAppColors(colors: { header: string; background: string }): void {
  if (!isVersionAtLeast(clientVersion, COLORS_SINCE)) return;
  if (HEX_COLOR.test(colors.header)) post('web_app_set_header_color', { color: colors.header });
  if (HEX_COLOR.test(colors.background)) {
    post('web_app_set_background_color', { color: colors.background });
    if (isVersionAtLeast(clientVersion, BOTTOM_BAR_SINCE)) {
      post('web_app_set_bottom_bar_color', { color: colors.background });
    }
  }
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function writeInsets(prefix: string, data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const insets = data as Record<string, unknown>;
  for (const side of SIDES) {
    const value = insets[side];
    // A number of CSS pixels; anything else (or a silly size) is ignored.
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 400) {
      document.documentElement.style.setProperty(`${prefix}-${side}`, `${value}px`);
    }
  }
}

/**
 * Keeps Telegram's safe areas in CSS variables on the root element:
 * `--tg-safe-{top,right,bottom,left}` (the device: notch, home indicator) and
 * `--tg-content-safe-{...}` (Telegram's own controls over a full-screen app). Layouts add them
 * to `env(safe-area-inset-*)`, which Telegram's webview does not fill in. Older clients send
 * nothing and the variables stay unset (0 in the layouts).
 */
export function followSafeAreas(): void {
  if (!isVersionAtLeast(clientVersion, SAFE_AREA_SINCE)) return;
  onMiniAppEvent('safe_area_changed', (data) => writeInsets('--tg-safe', data));
  onMiniAppEvent('content_safe_area_changed', (data) => writeInsets('--tg-content-safe', data));
  post('web_app_request_safe_area');
  post('web_app_request_content_safe_area');
}
