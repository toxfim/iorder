import { readonly, shallowRef } from 'vue';

export const TOAST_DURATION_MS = 4000;

export interface ToastOptions {
  /** Already translated by the caller. */
  readonly message: string;
  /** When both are given the toast shows an undo button. */
  readonly undoLabel?: string;
  readonly onUndo?: () => void;
  readonly durationMs?: number;
}

export interface ToastState extends ToastOptions {
  readonly id: number;
}

// One toast at a time, app-wide: a new toast replaces the old one and clears its timer
// (specs.md section 6).
const current = shallowRef<ToastState | null>(null);
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;
let remainingMs = 0;
let paused = false;

function arm(id: number, ms: number): void {
  clearTimeout(timer);
  startedAt = Date.now();
  remainingMs = ms;
  timer = setTimeout(() => {
    if (current.value?.id === id) current.value = null;
  }, ms);
}

export function dismissToast(): void {
  clearTimeout(timer);
  paused = false;
  current.value = null;
}

export function showToast(options: ToastOptions): number {
  const id = nextId++;
  paused = false;
  current.value = { ...options, id };
  arm(id, options.durationMs ?? TOAST_DURATION_MS);
  return id;
}

/** Hover or keyboard focus on the toast stops the countdown (WCAG 2.2.1 timing adjustable). */
export function pauseToast(): void {
  if (!current.value || paused) return;
  clearTimeout(timer);
  remainingMs -= Date.now() - startedAt;
  paused = true;
}

export function resumeToast(): void {
  const toast = current.value;
  if (!toast || !paused) return;
  paused = false;
  arm(toast.id, Math.max(remainingMs, 0));
}

export function undoToast(): void {
  const toast = current.value;
  dismissToast();
  toast?.onUndo?.();
}

export function useToast() {
  return { toast: readonly(current), showToast, dismissToast, undoToast, pauseToast, resumeToast };
}
