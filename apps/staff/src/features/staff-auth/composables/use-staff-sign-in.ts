import { onBeforeUnmount, ref, type Ref } from 'vue';
import { useServices } from '@/app/services';
import type {
  CurrentUser,
  PasswordCredentials,
  TelegramWidgetPayload,
} from '@/features/auth/api/auth-api';
import { ApiRateLimitedError } from '@core/lib/api-errors';

/**
 * `failed` is ONE message for every refusal (wrong login, wrong password, blocked, not staff,
 * server or network trouble): the screen must not tell an attacker which part was wrong.
 * `rateLimited` is the 429 (it reveals only that the server is throttling).
 */
export type SignInFailure = 'failed' | 'rateLimited';

export interface StaffSignIn {
  readonly busy: Readonly<Ref<boolean>>;
  readonly failure: Readonly<Ref<SignInFailure | null>>;
  /** Seconds until another attempt is allowed after a 429; 0 when allowed. */
  readonly waitSeconds: Readonly<Ref<number>>;
  /** True after a widget callback was dropped (busy or waiting): the person must press it again. */
  readonly widgetIgnored: Readonly<Ref<boolean>>;
  withPassword: (credentials: PasswordCredentials) => Promise<void>;
  withTelegramWidget: (payload: TelegramWidgetPayload) => Promise<void>;
}

/** Both website sign-in methods behind one busy flag, one failure message and one countdown. */
export function useStaffSignIn(
  onSignedIn: (user: CurrentUser) => void | Promise<void>,
): StaffSignIn {
  const { currentUser } = useServices();
  const busy = ref(false);
  const failure = ref<SignInFailure | null>(null);
  const waitSeconds = ref(0);
  const widgetIgnored = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function startCountdown(seconds: number): void {
    stopTimer();
    waitSeconds.value = seconds;
    timer = setInterval(() => {
      waitSeconds.value -= 1;
      if (waitSeconds.value <= 0) {
        waitSeconds.value = 0;
        stopTimer();
        widgetIgnored.value = false;
        if (failure.value === 'rateLimited') failure.value = null;
      }
    }, 1000);
  }

  async function attempt(signIn: () => Promise<CurrentUser>): Promise<void> {
    // A second click, Enter key or widget callback while one request runs (or while the server
    // asks us to wait) is dropped: it could never succeed and would only add load.
    if (busy.value || waitSeconds.value > 0) return;
    widgetIgnored.value = false;
    busy.value = true;
    failure.value = null;
    let user: CurrentUser;
    try {
      user = await signIn();
    } catch (caught) {
      if (caught instanceof ApiRateLimitedError) {
        failure.value = 'rateLimited';
        startCountdown(caught.retryAfterSeconds);
      } else {
        failure.value = 'failed';
      }
      busy.value = false;
      return;
    }
    try {
      await onSignedIn(user);
    } finally {
      busy.value = false;
    }
  }

  onBeforeUnmount(stopTimer);

  return {
    busy,
    failure,
    waitSeconds,
    widgetIgnored,
    withPassword: (credentials) => attempt(() => currentUser.signInWithPassword(credentials)),
    withTelegramWidget: async (payload) => {
      // The widget cannot be disabled like a button: say why nothing happened instead of
      // dropping the tap silently.
      if (busy.value || waitSeconds.value > 0) widgetIgnored.value = true;
      await attempt(() => currentUser.signInWithTelegramWidget(payload));
    },
  };
}
