import { orderStartParam } from '@iorder/shared';

/** How the staff app is opened as a Telegram Mini App. */
export interface StaffMiniAppOptions {
  /**
   * `TELEGRAM_STAFF_MINI_APP_URL`: the direct link `https://t.me/<bot>/<app>` of the staff Mini
   * App. Telegram signs the launch with the bot the link belongs to.
   */
  directLink?: string | undefined;
  /**
   * False when a separate staff bot signs staff in. A `web_app` button is signed by the bot that
   * SENT the message (the main bot), so such a launch would then sign nobody in.
   */
  mainBotSignsStaffIn?: boolean;
}

/**
 * Every link the bot puts in a message is built here, so a route change in a web app is a
 * one-file change. Customer links use `WEB_APP_URL` (the customer app); staff links use
 * `STAFF_WEB_APP_URL` (the staff app, ADR-001 3.5) and fall back to `WEB_APP_URL` when both apps
 * share one origin. Returns null for each link whose base URL is not set.
 */
export class WebLinks {
  private readonly base: string | null;
  private readonly staffBase: string | null;

  constructor(
    baseUrl: string | undefined,
    private readonly miniAppUrl: string | undefined = undefined,
    staffBaseUrl: string | undefined = undefined,
    private readonly staffMiniApp: StaffMiniAppOptions = {},
  ) {
    this.base = trimBase(baseUrl);
    this.staffBase = trimBase(staffBaseUrl) ?? this.base;
  }

  /** The Mini App direct link (`https://t.me/<bot>/<app>`) for the button under the price file. */
  miniApp(): string | null {
    return this.miniAppUrl ?? null;
  }

  /**
   * The Mini App direct link that opens one screen (`?startapp=<param>`; the customer app maps the
   * parameter to a route). Works for both `t.me/<bot>/<app>` and the main app `t.me/<bot>`.
   */
  miniAppStart(param: string): string | null {
    if (this.miniAppUrl === undefined) return null;
    const url = new URL(this.miniAppUrl);
    url.searchParams.set('startapp', param);
    return url.toString();
  }

  get configured(): boolean {
    return this.base !== null;
  }

  /** The customer app's front page; it sends each person to their own home. */
  home(): string | null {
    return this.base === null ? null : `${this.base}/`;
  }

  /** The customer price page: the button under the price list file posted to the groups. */
  customerPrices(): string | null {
    return join(this.base, '/prices');
  }

  /** An order page for the customer side (organization members). */
  customerOrder(orderId: string): string | null {
    return join(this.base, `/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * The customer Mini App direct link opened on one order: the "open in the app" button of a
   * customer-side order message. A plain link, so it also works in a group (where Telegram refuses
   * `web_app` buttons). Null without `TELEGRAM_MINI_APP_URL`.
   */
  customerOrderMiniApp(orderId: string): string | null {
    const param = orderStartParam(orderId);
    return param === null ? null : this.miniAppStart(param);
  }

  /** The staff app's front page; it sends each staff member to the first page of their role. */
  staffHome(): string | null {
    return this.staffBase === null ? null : `${this.staffBase}/`;
  }

  /** An order page for staff (manager, accountant, warehouse, driver, admin). */
  staffOrder(orderId: string): string | null {
    return join(this.staffBase, `/staff/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * The staff Mini App direct link opened on one order (`?startapp=order_<id>`, the staff app maps
   * the value to the order page): the "Open in the Mini App" button of a staff message. Null
   * without `TELEGRAM_STAFF_MINI_APP_URL` or for an id that is not an order id.
   */
  staffOrderMiniApp(orderId: string): string | null {
    const direct = this.staffMiniApp.directLink;
    const param = orderStartParam(orderId);
    if (direct === undefined || param === null) return null;
    const url = new URL(direct);
    url.searchParams.set('startapp', param);
    return url.toString();
  }

  /**
   * Whether a `web_app` button under a staff message signs the staff member in. It is signed by
   * the bot that sent the message; false once a separate staff bot hosts the staff Mini App.
   */
  get staffWebAppSignsIn(): boolean {
    return this.staffMiniApp.mainBotSignsStaffIn !== false;
  }
}

function trimBase(url: string | undefined): string | null {
  return url === undefined ? null : url.replace(/\/+$/, '');
}

function join(base: string | null, path: string): string | null {
  return base === null ? null : `${base}${path}`;
}
