import { API_BASE_URL, FAKE_API_ENABLED } from '@core/app/env';
import type { Services } from './services';

export interface CreateServicesOptions {
  /** The staff session ended on the server (a 401 on a signed-in call): show the login. */
  readonly onSessionExpired?: () => void;
}

/**
 * Picks the API adapters. Fakes exist only on the dev server (unless VITE_USE_REAL_API=true) or
 * when a build sets VITE_USE_FAKE_API=true. In a normal production build the condition is a
 * compile-time `false`, so the dynamic import (and every demo identity behind it) is removed from
 * the bundle; `pnpm check:bundle` verifies it. Otherwise the real HTTP clients are used.
 */
export async function createServices(options: CreateServicesOptions = {}): Promise<Services> {
  if (FAKE_API_ENABLED) {
    const { createFakeServices } = await import('@/app/fake-services');
    return createFakeServices();
  }
  const { createRealServices } = await import('@/app/create-real-services');
  return createRealServices({ baseUrl: API_BASE_URL, ...options });
}
