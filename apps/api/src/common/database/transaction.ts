import type { Tx } from './db-client.js';
import type { PrismaService } from './prisma.service.js';

// Prisma's default interactive-transaction timeout is 5 s. Bulk price edits (up to 500 items)
// plus waiting for a row lock held by a concurrent publish can exceed that, and a timeout
// would roll the whole change back. 20 s is generous for one human-triggered operation and
// still short enough that a stuck lock does not hold a connection for long.
export const TRANSACTION_TIMEOUT_MS = 20_000;
// How long to wait for a free connection from the pool before giving up.
export const TRANSACTION_MAX_WAIT_MS = 5_000;

/** The one place a plain transaction client becomes a branded `Tx`. */
export function runInTransaction<T>(
  prisma: PrismaService,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction((client) => work(client as Tx), {
    maxWait: TRANSACTION_MAX_WAIT_MS,
    timeout: TRANSACTION_TIMEOUT_MS,
  });
}
