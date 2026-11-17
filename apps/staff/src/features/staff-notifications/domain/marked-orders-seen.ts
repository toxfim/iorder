import type { MarkedOrderNotification } from '@iorder/shared/staff-auth';

// Per browser on purpose: the dot is a convenience and the list itself comes from the server, so a
// lost value only shows the dot once more.
const keyOf = (userId: string): string => `iorder.markedOrders.seenAt.${userId}`;

export function readSeenAt(userId: string): string | null {
  try {
    return localStorage.getItem(keyOf(userId));
  } catch {
    return null;
  }
}

export function writeSeenAt(userId: string, seenAt: string): void {
  try {
    localStorage.setItem(keyOf(userId), seenAt);
  } catch {
    // Private window or blocked storage: the dot simply comes back next time.
  }
}

export function hasUnread(
  items: readonly MarkedOrderNotification[],
  seenAt: string | null,
): boolean {
  const newest = items[0]?.createdAt;
  if (newest === undefined) return false;
  return seenAt === null || Date.parse(newest) > Date.parse(seenAt);
}
