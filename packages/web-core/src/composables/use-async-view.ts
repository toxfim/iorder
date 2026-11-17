import { onScopeDispose, ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import { PermissionDeniedError } from '@core/lib/api-errors';

/** The screen states every page must handle (CLAUDE.md frontend conventions). */
export type ViewState = 'loading' | 'ready' | 'empty' | 'error' | 'denied';

export interface UseAsyncViewOptions<T> {
  /** Decides when a successful response counts as "empty". Default: an empty array. */
  readonly isEmpty?: (data: T) => boolean;
}

export interface UseAsyncView<T> {
  readonly state: Ref<ViewState>;
  readonly data: ShallowRef<T | null>;
  readonly error: ShallowRef<unknown>;
  reload: () => Promise<void>;
}

function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

/**
 * Runs `loader` and maps its outcome to a ViewState for <StateView>. Starts loading immediately.
 * A newer reload wins: late answers from older calls are dropped.
 */
export function useAsyncView<T>(
  loader: () => Promise<T>,
  options: UseAsyncViewOptions<T> = {},
): UseAsyncView<T> {
  const isEmpty = options.isEmpty ?? defaultIsEmpty;
  const state = ref<ViewState>('loading');
  const data = shallowRef<T | null>(null);
  const error = shallowRef<unknown>(null);
  let run = 0;
  let disposed = false;

  async function reload(): Promise<void> {
    const mine = ++run;
    state.value = 'loading';
    error.value = null;
    try {
      const result = await loader();
      if (mine !== run || disposed) return;
      data.value = result;
      state.value = isEmpty(result) ? 'empty' : 'ready';
    } catch (caught) {
      if (mine !== run || disposed) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  onScopeDispose(() => {
    disposed = true;
  });

  void reload();
  return { state, data, error, reload };
}
