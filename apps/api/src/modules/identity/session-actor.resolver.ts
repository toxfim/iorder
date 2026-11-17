import type { ExecutionContext } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { ActorResolver } from '../../common/auth/actor-resolver.js';
import { isWellFormedApiToken } from './api-token.js';
import type { ApiTokenService } from './api-token.service.js';
import type { StaffSessionService } from './staff-session.service.js';

/** `Authorization: Bearer <token>`: a website session. No cookies, so there is no CSRF surface. */
const BEARER_SCHEME = /^bearer[ ]+(\S+)$/i;
const TMA_SCHEME = /^tma[ ]/i;

/** Builds the Actor from a staff website session. Every problem returns null (the guard answers 401). */
export class SessionActorResolver extends ActorResolver {
  constructor(private readonly sessions: StaffSessionService) {
    super();
  }

  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const token = readBearerToken(context);
    return token === null ? null : this.sessions.authenticate(token);
  }
}

export function readAuthorization(context: ExecutionContext): string | null {
  const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
  const header = request.headers?.['authorization'];
  return typeof header === 'string' ? header : null;
}

/** Builds the Actor from an API token (`Bearer iot_...`). Every problem returns null (401). */
export class ApiTokenActorResolver extends ActorResolver {
  constructor(private readonly tokens: ApiTokenService) {
    super();
  }

  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const token = readBearerToken(context);
    return token === null ? null : this.tokens.authenticate(token);
  }
}

function readBearerToken(context: ExecutionContext): string | null {
  const header = readAuthorization(context);
  return header === null ? null : (BEARER_SCHEME.exec(header)?.[1] ?? null);
}

/**
 * The ONE resolver of the app: routes a request by its Authorization scheme. `tma` (Telegram
 * Mini App init data, staff and customers) goes to the Telegram resolver; `Bearer` (a staff
 * website session) goes to the session resolver, unless the token has the API token shape
 * (`iot_` + 43 characters; a session token is never that long), which goes to the API token
 * resolver. Anything else is unauthenticated. Customer Bearer sessions resolve current membership
 * on every request.
 */
export class SchemeRoutingActorResolver extends ActorResolver {
  constructor(
    private readonly telegram: ActorResolver | null,
    private readonly session: ActorResolver,
    private readonly apiTokens: ActorResolver | null = null,
  ) {
    super();
  }

  resolve(context: ExecutionContext): Promise<Actor | null> {
    const header = readAuthorization(context);
    if (header === null) return Promise.resolve(null);
    if (TMA_SCHEME.test(header)) return this.telegram?.resolve(context) ?? Promise.resolve(null);
    const bearer = BEARER_SCHEME.exec(header)?.[1];
    if (bearer !== undefined && isWellFormedApiToken(bearer)) {
      return this.apiTokens?.resolve(context) ?? Promise.resolve(null);
    }
    if (bearer !== undefined) return this.session.resolve(context);
    return Promise.resolve(null);
  }
}
