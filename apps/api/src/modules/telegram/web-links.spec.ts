import { describe, expect, it } from 'vitest';
import { WebLinks } from './web-links.js';

// The customer app and the staff app are separate web apps (ADR-001 3.5) and may live on separate
// origins, so staff links need their own base when one is configured.
describe('WebLinks', () => {
  it('builds customer links from the web app base URL', () => {
    const links = new WebLinks('https://app.example.uz/');
    expect(links.home()).toBe('https://app.example.uz/');
    expect(links.customerOrder('o-1')).toBe('https://app.example.uz/orders/o-1');
  });

  it('builds staff links from the staff app base URL when it is set', () => {
    const links = new WebLinks('https://app.example.uz', undefined, 'https://staff.example.uz/');
    expect(links.staffOrder('o-1')).toBe('https://staff.example.uz/staff/orders/o-1');
    expect(links.customerOrder('o-1')).toBe('https://app.example.uz/orders/o-1');
  });

  it('falls back to the web app base URL for staff links (both apps on one origin)', () => {
    const links = new WebLinks('https://app.example.uz');
    expect(links.staffOrder('o 1')).toBe('https://app.example.uz/staff/orders/o%201');
  });

  it('builds the Mini App direct link of an order from the configured Mini App URL', () => {
    const orderId = '0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';
    const links = new WebLinks('https://app.example.uz', 'https://t.me/iorder_bot/app');
    expect(links.customerOrderMiniApp(orderId)).toBe(
      `https://t.me/iorder_bot/app?startapp=order_${orderId}`,
    );
    // The main Mini App of a bot has no app name in its link.
    expect(new WebLinks(undefined, 'https://t.me/iorder_bot').customerOrderMiniApp(orderId)).toBe(
      `https://t.me/iorder_bot?startapp=order_${orderId}`,
    );
  });

  it('builds no Mini App order link without the Mini App URL or for an id that is not an order id', () => {
    const orderId = '0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';
    expect(new WebLinks('https://app.example.uz').customerOrderMiniApp(orderId)).toBeNull();
    const links = new WebLinks('https://app.example.uz', 'https://t.me/iorder_bot/app');
    expect(links.customerOrderMiniApp('o 1&startapp=prices')).toBeNull();
  });

  describe('the staff Mini App (owner 2026-11-09)', () => {
    const ORDER_ID = '019a3f2e-7c11-7a44-9b0d-5e6f708192a3';
    const STAFF = 'https://staff.example.uz';
    const DIRECT = 'https://t.me/iorder_staff_bot/staff';

    it('builds its direct link with the order as the start parameter', () => {
      const links = new WebLinks('https://app.example.uz', undefined, STAFF, {
        directLink: DIRECT,
      });
      expect(links.staffOrderMiniApp(ORDER_ID)).toBe(`${DIRECT}?startapp=order_${ORDER_ID}`);
      // The customer Mini App link is a different setting and stays unset here.
      expect(links.customerOrderMiniApp(ORDER_ID)).toBeNull();
    });

    it('has no direct link without the setting, also when the customer Mini App is configured', () => {
      const links = new WebLinks('https://app.example.uz', 'https://t.me/iorder_bot/app', STAFF);
      expect(links.staffOrderMiniApp(ORDER_ID)).toBeNull();
    });

    it('builds no link for an id that is not an order id', () => {
      const links = new WebLinks(undefined, undefined, STAFF, { directLink: DIRECT });
      expect(links.staffOrderMiniApp('o 1&startapp=x')).toBeNull();
    });

    it('says a web_app button signs staff in unless a separate staff bot does', () => {
      expect(new WebLinks(undefined).staffWebAppSignsIn).toBe(true);
      expect(
        new WebLinks(undefined, undefined, STAFF, { mainBotSignsStaffIn: true }).staffWebAppSignsIn,
      ).toBe(true);
      // A web_app button is signed by the bot that sent the message: the main bot.
      expect(
        new WebLinks(undefined, undefined, STAFF, { mainBotSignsStaffIn: false })
          .staffWebAppSignsIn,
      ).toBe(false);
    });
  });

  it('builds no link without a base URL', () => {
    const links = new WebLinks(undefined);
    expect(links.configured).toBe(false);
    expect(links.home()).toBeNull();
    expect(links.customerOrder('o-1')).toBeNull();
    expect(links.staffOrder('o-1')).toBeNull();
  });
});
