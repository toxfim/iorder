import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STAFF_SESSION_STORAGE_KEY,
  createStaffSessionStore,
} from '@/features/staff-auth/session-store';
import { ApiRateLimitedError, UnauthenticatedError } from '@core/lib/api-errors';
import { setPageReloader } from '@core/lib/app-outdated';
import { createRealServices } from './create-real-services';

// A fake server that implements the api contract for the calls the web app makes at start-up and
// sign-in. Everything goes through the real http clients, the real stores and createRealServices.

const TOKEN = 'A'.repeat(43);
const USER_ID = '8f0c8f6a-2d33-4f5a-9d2e-3d2f4a1b9c11';
const ME = {
  userId: USER_ID,
  fullName: 'Aziza Manager',
  locale: 'UZ',
  staffRoles: ['MANAGER'],
  membership: null,
  contact: null,
  needsContact: false,
};
const SESSION = {
  expiresAt: '2026-10-30T10:00:00.000Z',
  idleExpiresAt: '2026-10-29T22:00:00.000Z',
};
const SUMMARY = {
  generatedAt: '2026-10-20T08:00:00.000Z',
  businessDate: '2026-10-20',
  ordersByStatus: { SUBMITTED: 2 },
  queues: [],
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const unauthorized = (): Response =>
  json(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthorized' } });

function createServer() {
  const calls: Call[] = [];
  const state = {
    tokenValid: true,
    initDataValid: true,
    loginStatus: 200 as number,
    retryAfter: '',
  };
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      authorization: headers.get('Authorization'),
      body,
    };
    calls.push(call);
    const path = url.replace(/^\/api/, '');
    const bearerOk =
      (call.authorization === `Bearer ${TOKEN}` && state.tokenValid) ||
      (call.authorization?.startsWith('tma ') === true && state.initDataValid);

    if (path === '/auth/password-login' && call.method === 'POST') {
      if (state.loginStatus === 429) {
        return Promise.resolve(
          json(
            429,
            { error: { code: 'RATE_LIMITED', message: 'slow down' } },
            { 'Retry-After': state.retryAfter },
          ),
        );
      }
      if (state.loginStatus === 401) return Promise.resolve(unauthorized());
      return Promise.resolve(json(200, { token: TOKEN, session: SESSION, me: ME }));
    }
    if (path === '/auth/session') {
      return Promise.resolve(bearerOk ? json(200, { session: SESSION, me: ME }) : unauthorized());
    }
    if (path === '/auth/logout') {
      return Promise.resolve(bearerOk ? new Response(null, { status: 204 }) : unauthorized());
    }
    if (path === '/staff/dashboard/summary') {
      return Promise.resolve(bearerOk ? json(200, SUMMARY) : unauthorized());
    }
    if (path === '/staff/drivers') {
      return Promise.resolve(bearerOk ? json(200, { items: [] }) : unauthorized());
    }
    return Promise.resolve(json(404, { error: { code: 'NOT_FOUND', message: 'no route' } }));
  };
  return { calls, state, fetchImpl: fetchImpl as typeof fetch };
}

function setup(options: { initData?: string | null } = {}) {
  const server = createServer();
  const onSessionExpired = vi.fn();
  const forgetInitData = vi.fn();
  const services = createRealServices({
    baseUrl: '/api',
    fetchImpl: server.fetchImpl,
    onSessionExpired,
    session: createStaffSessionStore(),
    readInitData: () => options.initData ?? null,
    forgetInitData,
  });
  return { server, services, onSessionExpired, forgetInitData };
}

describe('the staff web app over the real http clients', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it('signs in with a password: no Authorization header on the sign-in call, then Bearer everywhere', async () => {
    const { server, services } = setup();

    const user = await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });

    expect(user).toEqual({
      id: USER_ID,
      displayName: 'Aziza Manager',
      staffRoles: ['MANAGER'],
      organization: null,
    });
    expect(server.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/auth/password-login',
      authorization: null,
      body: { login: 'aziza', password: 'a long secret 123' },
    });

    await services.driversApi.listActiveDrivers();
    expect(server.calls.at(-1)).toMatchObject({
      url: '/api/staff/drivers',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('keeps the token for the next visit (localStorage) and never puts it in a URL', async () => {
    const { server, services } = setup();
    await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });
    await services.driversApi.listActiveDrivers();
    await services.dashboardSummaryStore.refresh();

    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBe(TOKEN);
    expect(window.sessionStorage.length).toBe(0);
    for (const call of server.calls) expect(call.url).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    // The password is never stored anywhere.
    expect(
      JSON.stringify([{ ...window.sessionStorage }, { ...window.localStorage }]),
    ).not.toContain('a long secret 123');
  });

  // The token is shared by every tab since it moved to localStorage: a tab must not keep showing
  // one person while the stored token belongs to another (or to nobody).
  it('starts again when another tab of the browser signed in or out', () => {
    const reload = vi.fn();
    setPageReloader(reload);
    let tellChanged: () => void = () => undefined;
    const server = createServer();
    createRealServices({
      baseUrl: '/api',
      fetchImpl: server.fetchImpl,
      session: {
        ...createStaffSessionStore(),
        onExternalChange: (listener) => {
          tellChanged = listener;
          return () => undefined;
        },
      },
      readInitData: () => null,
    });
    expect(reload).not.toHaveBeenCalled();

    tellChanged();

    expect(reload).toHaveBeenCalledTimes(1);
    setPageReloader();
  });

  it('restores the roles from GET /auth/session when a token is already stored', async () => {
    const { server, services } = setup();
    createStaffSessionStore().set(TOKEN);

    await services.currentUser.ensureLoaded();

    expect(services.currentUser.user.value?.staffRoles).toEqual(['MANAGER']);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({
      url: '/api/auth/session',
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('uses the Mini App init data (tma) when there is no website session', async () => {
    const { server, services } = setup({ initData: 'query_id=Q&hash=h' });

    await services.currentUser.ensureLoaded();

    expect(server.calls[0]?.authorization).toBe('tma query_id=Q&hash=h');
  });

  // Security review, 2026-11-10: the token now outlives the webview (localStorage). Person B
  // opening the staff Mini App on a device where person A signed in with a password must act as
  // B (Telegram's init data), never as A.
  it('fresh Mini App init data wins over a stored website token', async () => {
    createStaffSessionStore().set(TOKEN);
    const { server, services } = setup({ initData: 'query_id=Q&hash=h' });

    await services.currentUser.ensureLoaded();
    await services.driversApi.listActiveDrivers();

    for (const call of server.calls) expect(call.authorization).toBe('tma query_id=Q&hash=h');
  });

  it('a refused init data (a crafted link in a browser, or an unknown person) does not drop the stored token', async () => {
    createStaffSessionStore().set(TOKEN);
    const { server, services, onSessionExpired } = setup({ initData: 'query_id=Q&hash=forged' });
    server.state.initDataValid = false;

    await services.currentUser.ensureLoaded();

    expect(services.currentUser.user.value).toBeNull();
    // A's website session in other tabs is untouched: only the Telegram credential was refused.
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBe(TOKEN);
    expect(onSessionExpired).not.toHaveBeenCalled();
    for (const call of server.calls) expect(call.authorization).not.toContain(TOKEN);
  });

  it('a password sign-in made in this tab wins over the init data until it ends', async () => {
    const { server, services } = setup({ initData: 'query_id=Q&hash=h' });
    await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });
    await services.driversApi.listActiveDrivers();
    expect(server.calls.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    // The session ends: the tab falls back to Telegram's credential.
    server.state.tokenValid = false;
    await services.driversApi.listActiveDrivers().catch(() => undefined);
    await services.driversApi.listActiveDrivers();
    expect(server.calls.at(-1)?.authorization).toBe('tma query_id=Q&hash=h');
  });

  it('asks nothing when nobody has a credential', async () => {
    const { server, services } = setup();

    await services.currentUser.ensureLoaded();

    expect(server.calls).toHaveLength(0);
    expect(services.currentUser.user.value).toBeNull();
  });

  it('an expired stored token is dropped and the person is signed out', async () => {
    const { server, services } = setup();
    server.state.tokenValid = false;
    createStaffSessionStore().set(TOKEN);

    await services.currentUser.ensureLoaded();

    expect(services.currentUser.user.value).toBeNull();
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('shows no organization: a customer-shaped answer leaves the staff app without any role', async () => {
    const answer = {
      ...ME,
      staffRoles: [],
      membership: { organizationId: USER_ID, role: 'SHOP_OWNER' },
    };
    const customerServices = createRealServices({
      baseUrl: '/api',
      session: createStaffSessionStore(),
      readInitData: () => null,
      forgetInitData: () => undefined,
      fetchImpl: ((): Promise<Response> =>
        Promise.resolve(json(200, { token: TOKEN, session: SESSION, me: answer }))) as typeof fetch,
    });

    const user = await customerServices.currentUser.signInWithPassword({
      login: 'x',
      password: 'y',
    });

    expect(user.staffRoles).toEqual([]);
    expect(user.organization).toBeNull();
  });

  it('a 401 on a signed-in call ends the session once, clears the token and resets the stores', async () => {
    const { server, services, onSessionExpired } = setup();
    await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });
    await services.dashboardSummaryStore.refresh();
    expect(services.dashboardSummaryStore.summary.value).not.toBeNull();

    server.state.tokenValid = false;
    const results = await Promise.allSettled([
      services.driversApi.listActiveDrivers(),
      services.driversApi.listActiveDrivers(),
    ]);

    expect(
      results.every((r) => r.status === 'rejected' && r.reason instanceof UnauthenticatedError),
    ).toBe(true);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(services.currentUser.user.value).toBeNull();
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
    expect(services.dashboardSummaryStore.summary.value).toBeNull();
  });

  it('a wrong password (401 from the sign-in route) is not an expired session', async () => {
    const { server, services, onSessionExpired } = setup();
    server.state.loginStatus = 401;

    await expect(
      services.currentUser.signInWithPassword({ login: 'aziza', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);

    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('a 429 carries the Retry-After seconds', async () => {
    const { server, services } = setup();
    server.state.loginStatus = 429;
    server.state.retryAfter = '37';

    const failure = await services.currentUser
      .signInWithPassword({ login: 'aziza', password: 'x' })
      .catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ApiRateLimitedError);
    expect((failure as ApiRateLimitedError).retryAfterSeconds).toBe(37);
  });

  it('sign-out calls POST /auth/logout with the token, then clears every credential and store', async () => {
    const { server, services, forgetInitData } = setup();
    await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });
    await services.dashboardSummaryStore.refresh();

    await services.currentUser.signOut();

    expect(server.calls.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/auth/logout',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
    expect(forgetInitData).toHaveBeenCalledTimes(1);
    expect(services.currentUser.user.value).toBeNull();
    expect(services.dashboardSummaryStore.summary.value).toBeNull();
  });

  it('sign-out still clears everything when the server cannot be reached', async () => {
    const { server, services } = setup();
    await services.currentUser.signInWithPassword({
      login: 'aziza',
      password: 'a long secret 123',
    });
    server.state.tokenValid = false; // logout answers 401

    await services.currentUser.signOut();

    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBeNull();
    expect(services.currentUser.user.value).toBeNull();
  });

  it('screens without a backend route fail with a typed error instead of showing made-up data', async () => {
    const { services } = setup();

    await expect(services.activityStore.refresh()).resolves.toBeUndefined();
    expect(services.activityStore.state.value).toBe('error');
    await expect(services.dashboardApi.getSalesStats(7)).rejects.toMatchObject({
      name: 'FeatureUnavailableError',
    });
  });
});

describe('a late answer of an old session', () => {
  const TOKEN_B = 'B'.repeat(43);

  // Two accounts; the drivers answer of the first token is held until the test releases it.
  function createTwoAccountServer() {
    let releaseOld: (() => void) | null = null;
    const heldOld = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^\/api/, '');
      const auth = new Headers(init?.headers).get('Authorization');
      if (path === '/auth/password-login') {
        const body = JSON.parse(String(init?.body)) as { login: string };
        const token = body.login === 'a' ? TOKEN : TOKEN_B;
        return json(200, { token, session: SESSION, me: ME });
      }
      if (path === '/auth/logout') return new Response(null, { status: 204 });
      if (path === '/staff/drivers') {
        if (auth === `Bearer ${TOKEN}`) {
          await heldOld;
          return unauthorized();
        }
        return json(200, { items: [] });
      }
      if (path === '/auth/session') return json(200, { session: SESSION, me: ME });
      return json(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
    }) as typeof fetch;
    return { fetchImpl, release: () => releaseOld?.() };
  }

  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('does not sign out the person who signed in afterwards', async () => {
    const server = createTwoAccountServer();
    const onSessionExpired = vi.fn();
    const services = createRealServices({
      baseUrl: '/api',
      fetchImpl: server.fetchImpl,
      onSessionExpired,
      session: createStaffSessionStore(),
      readInitData: () => null,
      forgetInitData: () => undefined,
    });
    await services.currentUser.signInWithPassword({ login: 'a', password: 'long secret 1' });
    const lateRead = services.driversApi.listActiveDrivers().catch((caught: unknown) => caught);

    await services.currentUser.signOut();
    await services.currentUser.signInWithPassword({ login: 'b', password: 'long secret 2' });
    server.release();
    await lateRead;

    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(services.currentUser.user.value).not.toBeNull();
    expect(window.localStorage.getItem(STAFF_SESSION_STORAGE_KEY)).toBe(TOKEN_B);
  });
});

describe('signing out while another request is still running', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('does not report an expired session, so no redirect to the page just left is added', async () => {
    let releaseLogout: () => void = () => undefined;
    const logoutGate = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^\/api/, '');
      if (path === '/auth/password-login') {
        return json(200, { token: TOKEN, session: SESSION, me: ME });
      }
      if (path === '/auth/logout') {
        await logoutGate;
        return new Response(null, { status: 204 });
      }
      return unauthorized();
    }) as typeof fetch;
    const onSessionExpired = vi.fn();
    const services = createRealServices({
      baseUrl: '/api',
      fetchImpl,
      onSessionExpired,
      session: createStaffSessionStore(),
      readInitData: () => null,
      forgetInitData: () => undefined,
    });
    await services.currentUser.signInWithPassword({ login: 'a', password: 'long secret 1' });

    const leaving = services.currentUser.signOut();
    await services.driversApi.listActiveDrivers().catch(() => undefined);
    releaseLogout();
    await leaving;

    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(services.currentUser.user.value).toBeNull();
  });
});
