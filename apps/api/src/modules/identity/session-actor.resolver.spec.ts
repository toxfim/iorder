import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../common/auth/actor.js';
import { ActorResolver } from '../../common/auth/actor-resolver.js';
import { generateApiToken } from './api-token.js';
import { generateSessionToken } from './session-token.js';
import { SchemeRoutingActorResolver, SessionActorResolver } from './session-actor.resolver.js';
import type { StaffSessionService } from './staff-session.service.js';

const contextWith = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization === undefined ? {} : { authorization } }),
    }),
  }) as unknown as ExecutionContext;

const STAFF: Actor = { userId: 'u-1', staffRoles: ['MANAGER'], sessionId: 's-1' };

class Fixed extends ActorResolver {
  readonly calls = vi.fn();
  constructor(private readonly actor: Actor | null) {
    super();
  }
  resolve(): Promise<Actor | null> {
    this.calls();
    return Promise.resolve(this.actor);
  }
}

describe('SessionActorResolver', () => {
  const sessions = (actor: Actor | null) =>
    ({ authenticate: vi.fn().mockResolvedValue(actor) }) as unknown as StaffSessionService & {
      authenticate: ReturnType<typeof vi.fn>;
    };

  it('passes the Bearer token to the session service', async () => {
    const service = sessions(STAFF);
    const token = generateSessionToken();
    expect(await new SessionActorResolver(service).resolve(contextWith(`Bearer ${token}`))).toEqual(
      STAFF,
    );
    expect(service.authenticate).toHaveBeenCalledWith(token);
  });

  it('accepts the scheme in any letter case and rejects other shapes without a lookup', async () => {
    const service = sessions(STAFF);
    const resolver = new SessionActorResolver(service);
    expect(await resolver.resolve(contextWith(`bearer ${generateSessionToken()}`))).toEqual(STAFF);
    service.authenticate.mockClear();
    for (const header of [
      undefined,
      'Bearer',
      'Bearer ',
      'Basic abc',
      'tma abc',
      `Token ${generateSessionToken()}`,
    ]) {
      expect(await resolver.resolve(contextWith(header)), String(header)).toBeNull();
    }
    expect(service.authenticate).not.toHaveBeenCalled();
  });
});

describe('SchemeRoutingActorResolver', () => {
  const MINI_APP: Actor = { userId: 'u-2', staffRoles: [] };

  it('sends tma to the Telegram resolver and Bearer to the session resolver, never crossing', async () => {
    const telegram = new Fixed(MINI_APP);
    const session = new Fixed(STAFF);
    const router = new SchemeRoutingActorResolver(telegram, session);
    expect(await router.resolve(contextWith('tma data'))).toEqual(MINI_APP);
    expect(session.calls).not.toHaveBeenCalled();
    expect(await router.resolve(contextWith('Bearer token'))).toEqual(STAFF);
    expect(telegram.calls).toHaveBeenCalledTimes(1);
  });

  it('answers null for no header or an unknown scheme without calling either', async () => {
    const telegram = new Fixed(MINI_APP);
    const session = new Fixed(STAFF);
    const router = new SchemeRoutingActorResolver(telegram, session);
    for (const header of [undefined, 'Basic abc', 'Digest x', '']) {
      expect(await router.resolve(contextWith(header))).toBeNull();
    }
    expect(telegram.calls).not.toHaveBeenCalled();
    expect(session.calls).not.toHaveBeenCalled();
  });

  it('treats tma as unauthenticated when no bot token is configured, but Bearer still works', async () => {
    const router = new SchemeRoutingActorResolver(null, new Fixed(STAFF));
    expect(await router.resolve(contextWith('tma data'))).toBeNull();
    expect(await router.resolve(contextWith('Bearer token'))).toEqual(STAFF);
  });

  it('sends a Bearer token of the API token shape to the API token resolver only', async () => {
    const TOKEN: Actor = {
      userId: 'u-3',
      staffRoles: ['ADMIN'],
      scopes: ['MANAGE_PRODUCT_IMAGES'],
    };
    const session = new Fixed(STAFF);
    const apiTokens = new Fixed(TOKEN);
    const router = new SchemeRoutingActorResolver(null, session, apiTokens);
    expect(await router.resolve(contextWith(`Bearer ${generateApiToken()}`))).toEqual(TOKEN);
    expect(session.calls).not.toHaveBeenCalled();
    // A session token, or something that only starts like an API token, stays a session token.
    expect(await router.resolve(contextWith(`Bearer ${generateSessionToken()}`))).toEqual(STAFF);
    expect(await router.resolve(contextWith('Bearer iot_short'))).toEqual(STAFF);
    expect(apiTokens.calls).toHaveBeenCalledTimes(1);
    // Without an API token resolver such a token is simply unauthenticated.
    const withoutTokens = new SchemeRoutingActorResolver(null, new Fixed(STAFF));
    expect(await withoutTokens.resolve(contextWith(`Bearer ${generateApiToken()}`))).toBeNull();
  });
});
