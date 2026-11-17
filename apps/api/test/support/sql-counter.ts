import type { PrismaService } from '../../src/common/database/prisma.service.js';

interface QueryEvent {
  query: string;
}
type QuerySubscriber = (event: 'query', handler: (e: QueryEvent) => void) => void;

const collectors = new WeakMap<PrismaService, { current: string[] | null }>();

/**
 * Runs `action` and returns the SQL statements Prisma really sent to PostgreSQL meanwhile
 * (BEGIN/COMMIT of a transaction included), taken from Prisma's own query events. Counting
 * statements, not service calls, is what proves "a fixed number of queries whatever the size".
 */
export async function recordSql(
  prisma: PrismaService,
  action: () => Promise<unknown>,
): Promise<string[]> {
  let state = collectors.get(prisma);
  if (!state) {
    const created: { current: string[] | null } = { current: null };
    state = created;
    collectors.set(prisma, created);
    (prisma.$on as unknown as QuerySubscriber).call(prisma, 'query', (e) =>
      created.current?.push(e.query),
    );
  }
  const recorded: string[] = [];
  state.current = recorded;
  try {
    await action();
  } finally {
    state.current = null;
  }
  return recorded;
}
