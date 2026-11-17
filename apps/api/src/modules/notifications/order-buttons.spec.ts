import { LOCALES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { orderButtonLabels, orderButtons, type OrderButtonsInput } from './order-buttons.js';

const PAGE = 'https://order.example.uz/orders/o1';
const MINI_APP = 'https://t.me/iorder_bot/app?startapp=order_o1';

const customer = (over: Partial<OrderButtonsInput> = {}): OrderButtonsInput => ({
  audience: 'CUSTOMER',
  locale: 'UZ',
  privateChat: false,
  pageUrl: PAGE,
  miniAppLink: MINI_APP,
  ...over,
});

describe('customer-side order buttons ([C] 2026-11-09)', () => {
  it('in a group: two plain url buttons, the app first, then the browser', () => {
    expect(orderButtons(customer())).toEqual([
      { text: 'Ilovada ochish', url: MINI_APP },
      { text: 'Brauzerda ochish', url: PAGE },
    ]);
  });

  it('in a group there is never a web_app button: Telegram refuses them there', () => {
    for (const pageUrl of [PAGE, 'http://localhost:5174/orders/o1', null]) {
      for (const miniAppLink of [MINI_APP, null]) {
        const buttons = orderButtons(customer({ pageUrl, miniAppLink }));
        expect(buttons.every((button) => 'url' in button)).toBe(true);
      }
    }
  });

  it('in a group without the Mini App URL: only the browser button', () => {
    expect(orderButtons(customer({ miniAppLink: null }))).toEqual([
      { text: 'Brauzerda ochish', url: PAGE },
    ]);
  });

  it('in a group without the website address: only the app button', () => {
    expect(orderButtons(customer({ pageUrl: null }))).toEqual([
      { text: 'Ilovada ochish', url: MINI_APP },
    ]);
  });

  it('nothing configured: no buttons', () => {
    expect(orderButtons(customer({ pageUrl: null, miniAppLink: null }))).toEqual([]);
    expect(orderButtons(customer({ privateChat: true, pageUrl: null, miniAppLink: null }))).toEqual(
      [],
    );
  });

  it('in a private chat: the order page opens as a Mini App, with or without the Mini App URL', () => {
    for (const miniAppLink of [MINI_APP, null]) {
      expect(orderButtons(customer({ privateChat: true, miniAppLink }))).toEqual([
        { text: 'Ilovada ochish', webAppUrl: PAGE },
        { text: 'Brauzerda ochish', url: PAGE },
      ]);
    }
  });

  it('in a private chat a page that is not https cannot be a Mini App: the direct link, or nothing', () => {
    const page = 'http://localhost:5174/orders/o1';
    expect(orderButtons(customer({ privateChat: true, pageUrl: page }))).toEqual([
      { text: 'Ilovada ochish', url: MINI_APP },
      { text: 'Brauzerda ochish', url: page },
    ]);
    expect(orderButtons(customer({ privateChat: true, pageUrl: page, miniAppLink: null }))).toEqual(
      [{ text: 'Brauzerda ochish', url: page }],
    );
  });

  it('labels follow the reader language', () => {
    expect(orderButtons(customer({ locale: 'RU' })).map((button) => button.text)).toEqual([
      'Открыть в приложении',
      'Открыть в браузере',
    ]);
    expect(orderButtons(customer({ locale: 'EN' })).map((button) => button.text)).toEqual([
      'Open in the app',
      'Open in the browser',
    ]);
  });
});

describe('staff order buttons stay as they were ([C] 2026-10-25)', () => {
  const STAFF_PAGE = 'https://staff.example.uz/staff/orders/o1';
  const staff = (over: Partial<OrderButtonsInput> = {}): OrderButtonsInput => ({
    audience: 'STAFF',
    locale: 'EN',
    privateChat: true,
    pageUrl: STAFF_PAGE,
    miniAppLink: null,
    ...over,
  });

  it('the website first, then the same page as a Mini App', () => {
    expect(orderButtons(staff())).toEqual([
      { text: 'Open on the website', url: STAFF_PAGE },
      { text: 'Open in the Mini App', webAppUrl: STAFF_PAGE },
    ]);
  });

  it('only the website button for a staff app that is not https, none without its address', () => {
    const page = 'http://localhost:5173/staff/orders/o1';
    expect(orderButtons(staff({ pageUrl: page }))).toEqual([
      { text: 'Open on the website', url: page },
    ]);
    expect(orderButtons(staff({ pageUrl: null }))).toEqual([]);
  });
});

// Owner 2026-11-09: staff use the staff app as a Mini App. The registered staff Mini App is the
// button wherever it is configured; a separate staff bot switches the web_app fallback off.
describe('staff order buttons with the staff Mini App settings', () => {
  const STAFF_PAGE = 'https://staff.example.uz/staff/orders/o1';
  const DIRECT = 'https://t.me/iorder_staff_bot/staff?startapp=order_o1';
  const staff = (over: Partial<OrderButtonsInput> = {}): OrderButtonsInput => ({
    audience: 'STAFF',
    locale: 'EN',
    privateChat: true,
    pageUrl: STAFF_PAGE,
    miniAppLink: null,
    preferMiniAppLink: true,
    webAppSignsIn: true,
    ...over,
  });

  it('the direct link of the staff Mini App replaces the web_app button, whichever bot signs staff in', () => {
    for (const webAppSignsIn of [true, false]) {
      expect(orderButtons(staff({ miniAppLink: DIRECT, webAppSignsIn }))).toEqual([
        { text: 'Open on the website', url: STAFF_PAGE },
        { text: 'Open in the Mini App', url: DIRECT },
      ]);
    }
  });

  it('without the direct link the button stays the web_app button of the sending bot', () => {
    expect(orderButtons(staff())).toEqual([
      { text: 'Open on the website', url: STAFF_PAGE },
      { text: 'Open in the Mini App', webAppUrl: STAFF_PAGE },
    ]);
  });

  it('a separate staff bot without a direct link leaves only the website button', () => {
    // A web_app launch is signed by the sending (main) bot and would sign nobody in.
    expect(orderButtons(staff({ webAppSignsIn: false }))).toEqual([
      { text: 'Open on the website', url: STAFF_PAGE },
    ]);
  });

  it('a staff app that is not https still gets the direct link, never a web_app button', () => {
    const page = 'http://localhost:5173/staff/orders/o1';
    expect(orderButtons(staff({ pageUrl: page, miniAppLink: DIRECT }))).toEqual([
      { text: 'Open on the website', url: page },
      { text: 'Open in the Mini App', url: DIRECT },
    ]);
    expect(orderButtons(staff({ pageUrl: page }))).toEqual([
      { text: 'Open on the website', url: page },
    ]);
  });

  it('the customer side is not affected: a private chat keeps the web_app button', () => {
    expect(
      orderButtons({
        audience: 'CUSTOMER',
        locale: 'EN',
        privateChat: true,
        pageUrl: 'https://order.example.uz/orders/o1',
        miniAppLink: 'https://t.me/iorder_bot/app?startapp=order_o1',
      }),
    ).toEqual([
      { text: 'Open in the app', webAppUrl: 'https://order.example.uz/orders/o1' },
      { text: 'Open in the browser', url: 'https://order.example.uz/orders/o1' },
    ]);
  });
});

describe('button labels', () => {
  it('exist in every language for both readers and differ between the two buttons', () => {
    for (const audience of ['STAFF', 'CUSTOMER'] as const) {
      for (const locale of LOCALES) {
        const labels = orderButtonLabels(audience, locale);
        expect(labels.web.length).toBeGreaterThan(0);
        expect(labels.miniApp.length).toBeGreaterThan(0);
        expect(labels.web).not.toBe(labels.miniApp);
      }
    }
  });
});
