// The signed Telegram Login Widget is loaded at runtime by website sign-in screens only,
// when a bot username is configured. Mini App startup does not mount it.
// This file is the only place that names the script URL.

export const TELEGRAM_WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js';

/** The global the widget calls (`data-onauth`). Registered while the widget is mounted only. */
export const TELEGRAM_WIDGET_CALLBACK = 'iorderTelegramLogin';

export interface WidgetHandlers {
  /** The signed-in Telegram user exactly as the widget produced it (the signature covers it). */
  readonly onAuth: (payload: Readonly<Record<string, unknown>>) => void;
  /** The script could not be loaded (blocked, offline). */
  readonly onLoadError: () => void;
}

/** Adds the widget script to `container`; the returned function removes everything again. */
export function mountTelegramWidget(
  container: HTMLElement,
  botUsername: string,
  handlers: WidgetHandlers,
): () => void {
  const globals = window as unknown as Record<string, unknown>;
  const callback = (user: unknown): void => {
    if (typeof user === 'object' && user !== null) handlers.onAuth(user as Record<string, unknown>);
  };
  globals[TELEGRAM_WIDGET_CALLBACK] = callback;

  const script = document.createElement('script');
  script.async = true;
  script.src = TELEGRAM_WIDGET_SRC;
  // The login URL can carry `?redirect=<internal path>`; Telegram only needs to see the origin.
  script.referrerPolicy = 'origin';
  script.setAttribute('data-telegram-login', botUsername);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-userpic', 'false');
  script.setAttribute('data-radius', '12');
  script.setAttribute('data-onauth', `${TELEGRAM_WIDGET_CALLBACK}(user)`);
  script.addEventListener('error', handlers.onLoadError);
  container.appendChild(script);

  return () => {
    script.removeEventListener('error', handlers.onLoadError);
    container.replaceChildren();
    // Only remove our own registration (a second mount must not lose its callback).
    if (globals[TELEGRAM_WIDGET_CALLBACK] === callback) delete globals[TELEGRAM_WIDGET_CALLBACK];
  };
}
