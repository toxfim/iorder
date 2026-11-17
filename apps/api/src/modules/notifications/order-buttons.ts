import type { Locale } from '@iorder/shared';
import type { MessageButton } from '../telegram/index.js';
import type { Audience } from './message-templates.js';

// The buttons under an order message. PURE. One builder for staff ([C] 2026-10-25) and for the
// customer side ([C] 2026-11-09): the order is opened by a button, never by a link in the text.
//
// What Telegram allows decides the kind of button:
//  - a `web_app` button (the page opens as a Mini App) exists in private chats only, and only for
//    an https page;
//  - in a group every button must be a plain `url` button, so there the Mini App is opened by its
//    direct link (`t.me/<bot>/<app>?startapp=...`, from `TELEGRAM_MINI_APP_URL`);
//  - a `web_app` button is signed by the bot that SENT the message. Staff may be bound to a
//    separate staff bot (owner 2026-11-09): then that button would sign nobody in, and only the
//    staff Mini App's own direct link (`TELEGRAM_STAFF_MINI_APP_URL`) is a way in.

interface Labels {
  web: string;
  miniApp: string;
}

const LABELS: Record<Audience, Record<Locale, Labels>> = {
  STAFF: {
    UZ: { web: "Veb'da ochish", miniApp: "Mini App'da ochish" },
    RU: { web: 'Открыть на сайте', miniApp: 'Открыть в Mini App' },
    EN: { web: 'Open on the website', miniApp: 'Open in the Mini App' },
  },
  CUSTOMER: {
    UZ: { web: 'Brauzerda ochish', miniApp: 'Ilovada ochish' },
    RU: { web: 'Открыть в браузере', miniApp: 'Открыть в приложении' },
    EN: { web: 'Open in the browser', miniApp: 'Open in the app' },
  },
};

export function orderButtonLabels(audience: Audience, locale: Locale): Labels {
  return LABELS[audience][locale];
}

export interface OrderButtonsInput {
  audience: Audience;
  locale: Locale;
  /** A person's private chat with the bot; false for a group. */
  privateChat: boolean;
  /** The order page in this reader's web app; null when the app's address is not configured. */
  pageUrl: string | null;
  /** The Mini App direct link opened on the order; null when there is none for this reader. */
  miniAppLink: string | null;
  /**
   * True when the direct link is used wherever it exists, also in a private chat: the staff Mini
   * App, which the owner registers on purpose. Otherwise (the customer side) a private chat gets
   * the page itself as a `web_app` button and the link serves the groups.
   */
  preferMiniAppLink?: boolean;
  /**
   * False when a `web_app` button would sign the reader in as nobody (staff bound to a separate
   * staff bot). No such button is built then. Default: true.
   */
  webAppSignsIn?: boolean;
}

function miniAppButton(text: string, input: OrderButtonsInput): MessageButton[] {
  const link: MessageButton[] =
    input.miniAppLink === null ? [] : [{ text, url: input.miniAppLink }];
  if (input.preferMiniAppLink === true && link.length > 0) return link;
  const page = input.pageUrl;
  if (input.webAppSignsIn !== false && input.privateChat && page?.startsWith('https://') === true) {
    return [{ text, webAppUrl: page }];
  }
  return link;
}

/**
 * One row of buttons, each only when it has somewhere to go. Staff read "website, Mini App"; the
 * customer side reads "app, browser" (the app is where customers order).
 */
export function orderButtons(input: OrderButtonsInput): MessageButton[] {
  const labels = orderButtonLabels(input.audience, input.locale);
  const web: MessageButton[] =
    input.pageUrl === null ? [] : [{ text: labels.web, url: input.pageUrl }];
  const miniApp = miniAppButton(labels.miniApp, input);
  return input.audience === 'STAFF' ? [...web, ...miniApp] : [...miniApp, ...web];
}
