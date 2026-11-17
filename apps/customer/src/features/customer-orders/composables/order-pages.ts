import type { CustomerOrderGroup, CustomerOrderSummary, OrderStatus } from '@iorder/shared';
import type { CustomerOrdersApi } from '../api/customer-orders-api';

// Reads the orders list page by page. The server filters by ONE status (or by a group), while a
// customer filters by a state that stands for several statuses, so a state filter reads one stream
// per status and merges them here, newest first. The result is the list the server would give for
// those statuses together: every order once, none skipped.

export interface OrderPagesQuery {
  readonly group?: CustomerOrderGroup;
  readonly search?: string;
}

export interface OrderPages {
  /** The next orders, newest first. Empty only when nothing is left. */
  next(): Promise<readonly CustomerOrderSummary[]>;
  hasMore(): boolean;
}

interface Stream {
  readonly status: OrderStatus | null;
  /** Read from the server, not handed out yet. */
  readonly waiting: CustomerOrderSummary[];
  /** Undefined before the first read, null after the last page. */
  cursor: string | null | undefined;
}

const finished = (stream: Stream): boolean => stream.cursor === null;

/** Newest first, as the server sorts; the id settles two orders of the same instant. */
function newerFirst(a: CustomerOrderSummary, b: CustomerOrderSummary): number {
  return b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id);
}

/** `statuses` null: everything the query matches, in the server's own pages. */
export function createOrderPages(
  api: Pick<CustomerOrdersApi, 'list'>,
  query: OrderPagesQuery,
  statuses: readonly OrderStatus[] | null,
): OrderPages {
  const streams: Stream[] = (statuses ?? [null]).map((status) => ({
    status,
    waiting: [],
    cursor: undefined,
  }));

  // A stream changes only after its own answer arrived, so a failed read leaves every stream
  // where it was and the retry reads just the pages that are still missing.
  async function read(stream: Stream): Promise<void> {
    const page = await api.list({
      ...query,
      ...(stream.status === null ? {} : { status: stream.status }),
      ...(typeof stream.cursor === 'string' ? { cursor: stream.cursor } : {}),
    });
    stream.waiting.push(...page.orders);
    stream.cursor = page.nextCursor;
  }

  return {
    async next() {
      await Promise.all(
        streams.filter((stream) => stream.waiting.length === 0 && !finished(stream)).map(read),
      );
      const out: CustomerOrderSummary[] = [];
      // Stop as soon as one unfinished stream runs dry: its next order may be newer than what the
      // other streams still hold.
      while (streams.every((stream) => stream.waiting.length > 0 || finished(stream))) {
        const heads = streams.flatMap((stream) => stream.waiting.slice(0, 1));
        const newest = [...heads].sort(newerFirst)[0];
        if (newest === undefined) break;
        streams.find((stream) => stream.waiting[0] === newest)?.waiting.shift();
        out.push(newest);
      }
      return out;
    },
    hasMore: () => streams.some((stream) => stream.waiting.length > 0 || !finished(stream)),
  };
}
