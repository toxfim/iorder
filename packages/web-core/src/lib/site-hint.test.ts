import { describe, expect, it } from 'vitest';
import {
  SITE_HINT_MAX_AGE_SECONDS,
  clearSiteHint,
  hasAnySiteHint,
  hasSiteHintFor,
  setSiteHint,
  sharedCookieDomain,
  siteHintCookieName,
  type CookieJar,
} from './site-hint';

const STAFF = { hostname: 'dev.dashboard.iorder.uz', protocol: 'https:' };
const CUSTOMER = { hostname: 'dev.order.iorder.uz', protocol: 'https:' };
const CUSTOMER_URL = 'https://dev.order.iorder.uz';
const STAFF_PAGE_URL = 'https://dev.dashboard.iorder.uz/handoff';

/** Records what was written and answers reads with the given cookie string. */
function jar(initial = ''): CookieJar & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    get cookie(): string {
      return initial;
    },
    set cookie(value: string) {
      written.push(value);
    },
  };
}

describe('the domain two sites share', () => {
  it('is the widest common suffix of at least two labels', () => {
    expect(sharedCookieDomain('dashboard.iorder.uz', 'order.iorder.uz')).toBe('iorder.uz');
    expect(sharedCookieDomain('dev.dashboard.iorder.uz', 'dev.order.iorder.uz')).toBe('iorder.uz');
    expect(sharedCookieDomain('a.b.shop.example.com', 'c.b.shop.example.com')).toBe(
      'b.shop.example.com',
    );
    expect(sharedCookieDomain('Dashboard.IOrder.uz', 'order.iorder.uz')).toBe('iorder.uz');
  });

  it('is empty for one and the same host', () => {
    expect(sharedCookieDomain('app.iorder.uz', 'app.iorder.uz')).toBe('');
  });

  it('never is a bare top-level domain, and there is none between unrelated sites', () => {
    expect(sharedCookieDomain('dashboard.iorder.uz', 'order.other.uz')).toBeNull();
    expect(sharedCookieDomain('iorder.uz', 'evil.com')).toBeNull();
    // A look-alike is not a subdomain.
    expect(sharedCookieDomain('dashboard.iorder.uz', 'order.eviliorder.uz')).toBeNull();
  });

  it('does not exist on localhost or IP addresses (local development)', () => {
    for (const [a, b] of [
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['localhost', 'order.iorder.uz'],
      ['192.168.1.10', '192.168.1.11'],
      ['[::1]', '[::1]'],
      ['', ''],
    ] as const) {
      expect(sharedCookieDomain(a, b), `${a} ${b}`).toBeNull();
    }
  });
});

describe('setting the hint on the company site', () => {
  it('writes a non-secret marker on the shared domain, for two weeks, named after its own host', () => {
    const cookies = jar();
    expect(setSiteHint(CUSTOMER_URL, STAFF, cookies)).toBe(true);
    expect(cookies.written).toEqual([
      `iorder_site_hint_dev_dashboard_iorder_uz=1; Path=/; Max-Age=${SITE_HINT_MAX_AGE_SECONDS}; SameSite=Lax; Domain=iorder.uz; Secure`,
    ]);
    expect(SITE_HINT_MAX_AGE_SECONDS).toBe(1_209_600);
  });

  it('staging and production under one parent domain use different names', () => {
    expect(siteHintCookieName('dashboard.iorder.uz')).not.toBe(
      siteHintCookieName('dev.dashboard.iorder.uz'),
    );
  });

  it('carries nothing of the person: no token, no id, no role', () => {
    const cookies = jar();
    setSiteHint(CUSTOMER_URL, STAFF, cookies);
    expect(cookies.written.join()).toMatch(/^iorder_site_hint_[a-z0-9_]+=1;/);
  });

  it('writes nothing where no cookie can reach the other site', () => {
    for (const [url, page] of [
      ['http://localhost:5174', { hostname: 'localhost', protocol: 'http:' }],
      ['http://127.0.0.1:5174', { hostname: '127.0.0.1', protocol: 'http:' }],
      ['https://order.elsewhere.uz', STAFF],
      ['not a url', STAFF],
    ] as const) {
      const cookies = jar();
      expect(setSiteHint(url, page, cookies), url).toBe(false);
      expect(cookies.written).toEqual([]);
    }
  });

  it('is host-only when both apps live on one host, and not Secure over plain http', () => {
    const cookies = jar();
    setSiteHint('http://app.iorder.uz', { hostname: 'app.iorder.uz', protocol: 'http:' }, cookies);
    expect(cookies.written).toEqual([
      `iorder_site_hint_app_iorder_uz=1; Path=/; Max-Age=${SITE_HINT_MAX_AGE_SECONDS}; SameSite=Lax`,
    ]);
  });

  it('survives a browser that blocks cookies', () => {
    const blocked: CookieJar = {
      get cookie(): string {
        throw new Error('blocked');
      },
      set cookie(_value: string) {
        throw new Error('blocked');
      },
    };
    expect(() => setSiteHint(CUSTOMER_URL, STAFF, blocked)).not.toThrow();
    expect(() => clearSiteHint(STAFF, blocked)).not.toThrow();
    expect(hasAnySiteHint(blocked)).toBe(false);
    expect(hasSiteHintFor(STAFF_PAGE_URL, CUSTOMER, blocked)).toBe(false);
  });
});

describe('clearing the hint', () => {
  it('expires it on the host and on every parent domain of at least two labels', () => {
    const cookies = jar();
    clearSiteHint(STAFF, cookies);
    const name = 'iorder_site_hint_dev_dashboard_iorder_uz';
    expect(cookies.written).toEqual([
      `${name}=; Path=/; Max-Age=0; SameSite=Lax`,
      `${name}=; Path=/; Max-Age=0; SameSite=Lax; Domain=dev.dashboard.iorder.uz`,
      `${name}=; Path=/; Max-Age=0; SameSite=Lax; Domain=dashboard.iorder.uz`,
      `${name}=; Path=/; Max-Age=0; SameSite=Lax; Domain=iorder.uz`,
    ]);
  });

  it('on localhost only the host-only cookie is touched', () => {
    const cookies = jar();
    clearSiteHint({ hostname: 'localhost', protocol: 'http:' }, cookies);
    expect(cookies.written).toHaveLength(1);
  });
});

describe('reading the hint on the customer site', () => {
  const hint = 'iorder_site_hint_dev_dashboard_iorder_uz=1';

  it('sees the hint of its own installation', () => {
    const cookies = jar(`theme=dark; ${hint}; other=2`);
    expect(hasAnySiteHint(cookies)).toBe(true);
    expect(hasSiteHintFor(STAFF_PAGE_URL, CUSTOMER, cookies)).toBe(true);
  });

  it('a visitor without the hint is never sent anywhere', () => {
    for (const cookie of ['', 'theme=dark', 'iorder_site=1', 'x_iorder_site_hint_a=1']) {
      expect(hasAnySiteHint(jar(cookie)), cookie).toBe(false);
      expect(hasSiteHintFor(STAFF_PAGE_URL, CUSTOMER, jar(cookie)), cookie).toBe(false);
    }
  });

  it('does not take the hint of another installation for its own', () => {
    // The production dashboard was used in this browser; this is the staging customer site.
    const cookies = jar('iorder_site_hint_dashboard_iorder_uz=1');
    expect(hasAnySiteHint(cookies)).toBe(true);
    expect(hasSiteHintFor(STAFF_PAGE_URL, CUSTOMER, cookies)).toBe(false);
  });

  it('ignores a hint when the two sites share no domain, on localhost, or for a broken address', () => {
    const cookies = jar(hint);
    expect(
      hasSiteHintFor(
        STAFF_PAGE_URL,
        { hostname: 'order.elsewhere.uz', protocol: 'https:' },
        cookies,
      ),
    ).toBe(false);
    expect(
      hasSiteHintFor(
        'http://localhost:5173/handoff',
        { hostname: 'localhost', protocol: 'http:' },
        jar('iorder_site_hint_localhost=1'),
      ),
    ).toBe(false);
    expect(hasSiteHintFor('nonsense', CUSTOMER, cookies)).toBe(false);
  });
});
