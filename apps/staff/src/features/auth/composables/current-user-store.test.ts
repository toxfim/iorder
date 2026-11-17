import { describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { NetworkError } from '@core/lib/api-errors';
import { createAppRouter } from '@/router';
import type { AuthApi, CurrentUser } from '../api/auth-api';
import { createCurrentUserStore } from './current-user-store';

const manager: CurrentUser = {
  id: 'u1',
  displayName: 'Aziza',
  staffRoles: ['MANAGER'],
  organization: null,
};

function apiWith(getCurrentUser: AuthApi['getCurrentUser']): AuthApi {
  return { getCurrentUser, signOut: () => Promise.resolve() };
}

describe('a boot-time failure of the session read', () => {
  it('is an error state, not a signed-out person, and can be retried', async () => {
    const read = vi
      .fn<AuthApi['getCurrentUser']>()
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValueOnce(manager);
    const store = createCurrentUserStore(apiWith(read));

    await store.ensureLoaded();
    expect(store.loadError.value).toBeInstanceOf(NetworkError);
    expect(store.user.value).toBeNull();

    await store.retry();
    expect(store.loadError.value).toBeNull();
    expect(store.user.value).toEqual(manager);
    await store.ensureLoaded();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('sends a protected page to the retry screen and keeps the intended page for later', async () => {
    const read = vi
      .fn<AuthApi['getCurrentUser']>()
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValue(manager);
    const store = createCurrentUserStore(apiWith(read));
    const router = createAppRouter(store, createMemoryHistory());

    await router.push('/staff/orders');
    expect(router.currentRoute.value.name).toBe('session-error');
    expect(router.currentRoute.value.query.redirect).toBe('/staff/orders');

    // Opening the retry screen again does not hammer the server by itself.
    await router.replace('/session-error?redirect=%2Fstaff%2Forders');
    expect(read).toHaveBeenCalledTimes(1);

    await store.retry();
    await router.replace('/staff/orders');
    expect(router.currentRoute.value.path).toBe('/staff/orders');
  });

  it('a 401 still means signed out (the adapter answers null) and goes to the login', async () => {
    const store = createCurrentUserStore(apiWith(() => Promise.resolve(null)));
    const router = createAppRouter(store, createMemoryHistory());

    await router.push('/staff/orders');

    expect(router.currentRoute.value.name).toBe('login');
    expect(store.loadError.value).toBeNull();
  });
});

describe('the person signs out while a request is still running', () => {
  it('a 401 caused by the own sign-out does not end the session a second time', async () => {
    let finishSignOut: () => void = () => undefined;
    const api: AuthApi = {
      getCurrentUser: () => Promise.resolve(manager),
      signOut: () =>
        new Promise<void>((resolve) => {
          finishSignOut = resolve;
        }),
    };
    const store = createCurrentUserStore(api);
    await store.ensureLoaded();

    const leaving = store.signOut();
    expect(store.expire()).toBe(false);
    finishSignOut();
    await leaving;

    expect(store.user.value).toBeNull();
  });
});

describe('the person renames themselves in the profile', () => {
  it('changes the shown name only, and does nothing when nobody is signed in', async () => {
    const store = createCurrentUserStore(apiWith(() => Promise.resolve(manager)));
    store.setDisplayName('Nobody');
    expect(store.user.value).toBeNull();

    await store.ensureLoaded();
    store.setDisplayName('Aziza Karimova');
    expect(store.user.value).toEqual({ ...manager, displayName: 'Aziza Karimova' });
  });
});
