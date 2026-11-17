import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';

/**
 * Whole seconds left until an ISO instant, ticking once a second while there are any. Only a
 * courtesy on the screen: the device clock may be wrong, and the server decides.
 */
export function useCountdown(until: MaybeRefOrGetter<string | null>) {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  const secondsLeft = computed(() => {
    const end = toValue(until);
    if (end === null) return 0;
    return Math.max(0, Math.ceil((new Date(end).getTime() - now.value) / 1000));
  });

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function tick(): void {
    now.value = Date.now();
    if (secondsLeft.value === 0) stop();
  }

  watch(
    () => toValue(until),
    () => {
      stop();
      now.value = Date.now();
      if (secondsLeft.value > 0) timer = setInterval(tick, 1000);
    },
    { immediate: true },
  );
  onScopeDispose(stop);

  return { secondsLeft };
}

/** 125 becomes "2:05". */
export function formatSecondsLeft(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
