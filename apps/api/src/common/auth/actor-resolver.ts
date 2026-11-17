import type { ExecutionContext } from '@nestjs/common';
import type { Actor } from './actor.js';

/**
 * Turns a request into an Actor. The real implementation arrives with Telegram
 * authentication (Phase 2) and must verify Telegram signatures before trusting anything.
 *
 * Deliberately NO default implementation is registered anywhere in the app: without one,
 * the guard rejects every request with 401. Only tests provide their own resolver.
 */
export abstract class ActorResolver {
  /** Returns null when the request carries no valid credentials. */
  abstract resolve(context: ExecutionContext): Promise<Actor | null>;
}
