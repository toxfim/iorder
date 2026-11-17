import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INIT_DATA_STORAGE_KEY,
  captureLaunchParams,
  forgetInitData,
  forgetLaunch,
  isTelegramLaunch,
  readInitData,
  readLaunchFirstName,
  readLaunchUserId,
  takeStartParam,
} from './launch';

const INIT_DATA = 'query_id=AAH&user=%7B%22id%22%3A42%2C%22first_name%22%3A%22Jasur%22%7D&hash=abc';

function openAt(url: string): void {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  forgetLaunch();
  openAt('/prices');
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetLaunch();
  openAt('/');
});

describe('isTelegramLaunch (shapes the screen only)', () => {
  it('is false in an ordinary browser tab', () => {
    captureLaunchParams();
    expect(isTelegramLaunch()).toBe(false);
  });

  it('is true once Telegram opened the tab, also after the init data is forgotten (sign-out)', () => {
    openAt(`/#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=8.0`);
    captureLaunchParams();
    expect(isTelegramLaunch()).toBe(true);
    forgetInitData();
    expect(readInitData()).toBeNull();
    expect(isTelegramLaunch()).toBe(true);
  });

  it('is false again only when the launch itself is forgotten', () => {
    openAt(`/#tgWebAppData=${encodeURIComponent(INIT_DATA)}`);
    captureLaunchParams();
    forgetLaunch();
    expect(isTelegramLaunch()).toBe(false);
  });
});

describe('readLaunchUserId (shown to the person only, never an access decision)', () => {
  it('reads the Telegram user id as text', () => {
    expect(readLaunchUserId(INIT_DATA)).toBe('42');
    expect(readLaunchUserId('user=%7B%22id%22%3A%227000000001%22%7D')).toBe('7000000001');
  });

  it.each([null, '', 'hash=abc', 'user=not-json', 'user=%7B%22id%22%3A%22abc%22%7D', 'user=null'])(
    'returns null for %s',
    (initData) => {
      expect(readLaunchUserId(initData)).toBeNull();
    },
  );
});

describe('captureLaunchParams', () => {
  it('reads tgWebAppData from the URL fragment, keeps it for the session and clears the fragment', () => {
    const fragment = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=8.0&tgWebAppPlatform=ios`;
    openAt(`/prices?x=1${fragment}`);
    captureLaunchParams();

    expect(readInitData()).toBe(INIT_DATA);
    expect(window.sessionStorage.getItem(INIT_DATA_STORAGE_KEY)).toBe(INIT_DATA);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/prices?x=1');
  });

  it('does nothing without launch parameters (opened outside Telegram)', () => {
    openAt('/prices#section');
    captureLaunchParams();
    expect(readInitData()).toBeNull();
    expect(window.location.hash).toBe('#section');
  });

  it('survives a reload: the session copy is used when the fragment is gone', () => {
    window.sessionStorage.setItem(INIT_DATA_STORAGE_KEY, INIT_DATA);
    expect(readInitData()).toBe(INIT_DATA);
  });

  it('works when sessionStorage throws (the in-memory copy serves the page load)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    openAt(`/#tgWebAppData=${encodeURIComponent(INIT_DATA)}`);
    expect(() => captureLaunchParams()).not.toThrow();
    expect(readInitData()).toBe(INIT_DATA);
  });

  it('treats an empty value as absent', () => {
    openAt('/#tgWebAppData=');
    captureLaunchParams();
    expect(readInitData()).toBeNull();
  });
});

describe('readLaunchFirstName (a greeting only, never an access decision)', () => {
  it('reads the first name', () => {
    expect(readLaunchFirstName(INIT_DATA)).toBe('Jasur');
  });

  it.each([
    null,
    '',
    'hash=abc',
    'user=not-json',
    'user=%7B%22id%22%3A1%7D',
    'user=%7B%22first_name%22%3A42%7D',
    'user=%5B%5D',
    'user=null',
  ])('returns null for %s', (initData) => {
    expect(readLaunchFirstName(initData)).toBeNull();
  });

  it('cuts a very long name', () => {
    const user = encodeURIComponent(JSON.stringify({ first_name: 'A'.repeat(500) }));
    expect(readLaunchFirstName(`user=${user}`)?.length).toBe(60);
  });
});

describe('takeStartParam', () => {
  const launch = (extra: string, initData = INIT_DATA): void => {
    openAt(`/#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0${extra}`);
    captureLaunchParams();
  };

  it('returns the tgWebAppStartParam of the launch once', () => {
    launch('&tgWebAppStartParam=prices');
    expect(takeStartParam()).toBe('prices');
    expect(takeStartParam()).toBeNull();
  });

  it('falls back to start_param inside the init data', () => {
    launch('', `${INIT_DATA}&start_param=prices`);
    expect(takeStartParam()).toBe('prices');
  });

  it('keeps the start value of an order button whole (letters, digits, "_" and "-")', () => {
    const value = 'order_0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';
    launch(`&tgWebAppStartParam=${value}`);
    expect(takeStartParam()).toBe(value);
    launch('', `${INIT_DATA}&start_param=${value}`);
    expect(takeStartParam()).toBe(value);
  });

  it('ignores a value Telegram would never send', () => {
    launch(`&tgWebAppStartParam=${encodeURIComponent('../prices?x=1')}`);
    expect(takeStartParam()).toBeNull();
  });

  it('is null without a Telegram launch, and after the init data is forgotten', () => {
    openAt('/?tgWebAppStartParam=prices');
    captureLaunchParams();
    expect(takeStartParam()).toBeNull();

    launch('&tgWebAppStartParam=prices');
    forgetInitData();
    expect(takeStartParam()).toBeNull();
  });
});
