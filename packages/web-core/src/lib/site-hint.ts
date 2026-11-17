// A NON-secret cookie that only says "this browser has used the company's own site, signed in".
// The company site sets it on the domain both sites share and removes it when nobody is signed in
// there; the customer site reads it to decide whether one automatic handoff attempt is worth it.
//
// It is NOT a credential and is treated as untrusted on both ends: anybody can set it by hand,
// and all that buys them is one redirect to the company site's own sign-in page. Nothing is read
// from its value, and no address is ever taken from it.
//
// The name carries the company site's host, so two installations under one parent domain (staging
// and production) never overwrite each other's hint.

const NAME_PREFIX = 'iorder_site_hint_';

/**
 * How long the hint lives without the company site being opened: the idle limit of a session
 * (14 days, apps/api staff-auth.settings.ts). Each visit of that site sets it again, so the hint
 * and the session it speaks of end at about the same time.
 */
export const SITE_HINT_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

/** Where the cookie is read and written; `document` in the apps, a plain object in tests. */
export interface CookieJar {
  cookie: string;
}

/** The page's own address, as far as the hint needs it. */
export interface PageAddress {
  readonly hostname: string;
  readonly protocol: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A real DNS name with at least two labels: not localhost, not an IP address. */
function isSiteHost(hostname: string): boolean {
  if (IPV4.test(hostname) || hostname.includes(':')) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname);
}

export function siteHintCookieName(companySiteHost: string): string {
  return `${NAME_PREFIX}${companySiteHost.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

/**
 * The widest domain two hosts share, for the cookie's `Domain`: at least two labels, so a bare
 * top-level domain is never used (and a browser refuses a public suffix like `co.uz` by itself).
 * An empty string means "the same host" (a host-only cookie is enough); null means no cookie can
 * reach both: different sites, localhost or an IP address.
 */
export function sharedCookieDomain(hostA: string, hostB: string): string | null {
  const a = hostA.toLowerCase();
  const b = hostB.toLowerCase();
  if (!isSiteHost(a) || !isSiteHost(b)) return null;
  if (a === b) return '';
  const left = a.split('.').reverse();
  const right = b.split('.').reverse();
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const label = left[i];
    if (label === undefined || label !== right[i]) break;
    shared.unshift(label);
  }
  return shared.length >= 2 ? shared.join('.') : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cookieNames(jar: CookieJar): string[] {
  let raw: string;
  try {
    raw = jar.cookie;
  } catch {
    return [];
  }
  return raw
    .split(';')
    .map((pair) => pair.split('=', 1)[0]?.trim() ?? '')
    .filter((name) => name !== '');
}

function write(jar: CookieJar, value: string): void {
  try {
    jar.cookie = value;
  } catch {
    // Cookies blocked: there is simply no hint, and nobody is sent anywhere.
  }
}

/**
 * Called by the company site while a person who may be handed over is signed in. `otherSiteUrl`
 * is the customer site (from the api). Returns false when no cookie can reach that site from
 * here (local development), in which case nothing is written.
 */
export function setSiteHint(
  otherSiteUrl: string,
  page: PageAddress = window.location,
  jar: CookieJar = document,
): boolean {
  const other = hostOf(otherSiteUrl);
  const own = page.hostname.toLowerCase();
  const domain = other === null ? null : sharedCookieDomain(own, other);
  if (domain === null) return false;
  write(
    jar,
    [
      `${siteHintCookieName(own)}=1`,
      'Path=/',
      `Max-Age=${SITE_HINT_MAX_AGE_SECONDS}`,
      'SameSite=Lax',
      ...(domain === '' ? [] : [`Domain=${domain}`]),
      ...(page.protocol === 'https:' ? ['Secure'] : []),
    ].join('; '),
  );
  return true;
}

/**
 * Called by the company site when nobody is signed in there. The domain the hint was set on is
 * not remembered anywhere, so it is removed on the host and on every parent domain of it.
 */
export function clearSiteHint(
  page: PageAddress = window.location,
  jar: CookieJar = document,
): void {
  const own = page.hostname.toLowerCase();
  const name = siteHintCookieName(own);
  const expired = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  write(jar, expired);
  if (!isSiteHost(own)) return;
  const labels = own.split('.');
  for (let start = 0; start <= labels.length - 2; start += 1) {
    write(jar, `${expired}; Domain=${labels.slice(start).join('.')}`);
  }
}

/** Cheap first look for the customer site: is there any hint at all (of any installation)? */
export function hasAnySiteHint(jar: CookieJar = document): boolean {
  return cookieNames(jar).some((name) => name.startsWith(NAME_PREFIX));
}

/**
 * The customer site's real question: did THIS installation's company site (the address the api
 * names, never one taken from the cookie) leave its hint, and can it have done so (the two hosts
 * share a domain)? Always false on localhost and IP addresses.
 */
export function hasSiteHintFor(
  companySiteUrl: string,
  page: PageAddress = window.location,
  jar: CookieJar = document,
): boolean {
  const company = hostOf(companySiteUrl);
  if (company === null) return false;
  if (sharedCookieDomain(page.hostname, company) === null) return false;
  return cookieNames(jar).includes(siteHintCookieName(company));
}
