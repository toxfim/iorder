import { ApiResponseError, InvalidResponseError, NetworkError } from '@core/lib/api-errors';

// The Idempotency-Key of the order being placed. It lives in sessionStorage from the first tap
// until the server has answered definitively, so a retry after a dropped connection (the order
// may or may not exist) sends the SAME key and can never create a second order.
// The key is bound to the cart it was issued for and expires: a key kept after an unknown
// outcome must never be reused for a DIFFERENT cart, or the server would replay the old order.

export const SUBMIT_KEY_STORAGE_KEY = 'iorder.submitKey';
export const SUBMIT_KEY_TTL_MS = 10 * 60 * 1000;

interface StoredKey {
  key: string;
  fingerprint: string;
  issuedAt: number;
}

let memoryEntry: StoredKey | null = null;

function generateKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Identifies the cart and plan an order would be made from (order of lines does not matter). */
export function cartFingerprint(
  lines: readonly { productId: string; quantity: string }[],
  paymentPlan = '',
): string {
  const parts = lines.map((line) => `${line.productId}:${line.quantity}`).sort();
  return `${parts.join('|')}#${paymentPlan}`;
}

function isStoredKey(value: unknown): value is StoredKey {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'string' && typeof v.fingerprint === 'string' && typeof v.issuedAt === 'number'
  );
}

function readStored(): StoredKey | null {
  try {
    const raw = window.sessionStorage.getItem(SUBMIT_KEY_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      return isStoredKey(parsed) ? parsed : null;
    }
  } catch {
    // Falls back to the in-memory entry below.
  }
  return memoryEntry;
}

export function currentSubmitKey(fingerprint: string, now: number = Date.now()): string {
  const existing = readStored();
  if (
    existing &&
    existing.fingerprint === fingerprint &&
    now - existing.issuedAt >= 0 &&
    now - existing.issuedAt < SUBMIT_KEY_TTL_MS
  ) {
    return existing.key;
  }
  const entry: StoredKey = { key: generateKey(), fingerprint, issuedAt: now };
  memoryEntry = entry;
  try {
    window.sessionStorage.setItem(SUBMIT_KEY_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // The in-memory entry still protects a retry within this page load.
  }
  return entry.key;
}

export function forgetSubmitKey(): void {
  memoryEntry = null;
  try {
    window.sessionStorage.removeItem(SUBMIT_KEY_STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

/**
 * True when the request may have reached the server (no answer, a 5xx, a garbled body): the key
 * must be kept. Any definite answer (a 2xx, a 4xx) settles the attempt, so the key is dropped.
 */
export function outcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof InvalidResponseError) return true;
  return error instanceof ApiResponseError && error.status >= 500;
}
