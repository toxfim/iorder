import { readonly, ref, shallowRef } from 'vue';
import type {
  AuthApi,
  CurrentUser,
  PasswordCredentials,
  TelegramWidgetPayload,
} from '../api/auth-api';

/**
 * The signed-in user, held with plain Vue reactivity (no state library, per the approved
 * dependency list). The route guards and the shells read from it.
 */
export function createCurrentUserStore(
  api: AuthApi,
  options: { onSignedOut?: () => void; onSessionChanged?: () => void } = {},
) {
  const user = shallowRef<CurrentUser | null>(null);
  const loaded = ref(false);
  const loadError = shallowRef<unknown>(null);
  let pending: Promise<void> | null = null;
  let signingOut = false;

  /** Loads the session once; concurrent callers share the same request. */
  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve();
    pending ??= api
      .getCurrentUser()
      .then((found) => {
        // A sign-in that finished while this read was running is newer than the read.
        if (!loaded.value) user.value = found;
        loaded.value = true;
      })
      .catch((caught: unknown) => {
        // The server could not be asked (network, 5xx): that is not "signed out". The person and
        // the stored token stay as they are and the app shows a retry screen; `loaded` stays false
        // so the next ensureLoaded asks again. A 401 never gets here: the adapter answers null.
        loadError.value = caught;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  /** Asks the server again after a failed start-up read (the retry button). */
  function retry(): Promise<void> {
    loadError.value = null;
    return ensureLoaded();
  }

  /**
   * Asks the server who the person is once more, whatever is known now: the "try again" of the
   * Telegram refusal screen (the account may have been linked or unblocked meanwhile), and the
   * question a Mini App asks after its website session ended (Telegram may still sign them in).
   */
  function reload(): Promise<void> {
    loaded.value = false;
    loadError.value = null;
    return ensureLoaded();
  }

  function adopt(signedIn: CurrentUser): CurrentUser {
    // Another person or role: per-session caches are dropped before anything renders.
    options.onSessionChanged?.();
    user.value = signedIn;
    loadError.value = null;
    loaded.value = true;
    return signedIn;
  }

  function unsupported(method: string): never {
    throw new Error(`This sign-in method is not available: ${method}`);
  }

  const signIn = async (identityId: string): Promise<CurrentUser> =>
    adopt(await (api.signIn ?? (() => unsupported('demo')))(identityId));

  const signInWithPassword = async (credentials: PasswordCredentials): Promise<CurrentUser> =>
    adopt(await (api.signInWithPassword ?? (() => unsupported('password')))(credentials));

  const signInWithTelegramWidget = async (payload: TelegramWidgetPayload): Promise<CurrentUser> =>
    adopt(await (api.signInWithTelegramWidget ?? (() => unsupported('telegram widget')))(payload));

  function forget(): void {
    user.value = null;
    // Per-person memory (such as the remembered list filters) must not reach the next sign-in.
    options.onSignedOut?.();
    options.onSessionChanged?.();
  }

  async function signOut(): Promise<void> {
    // While the person leaves, a 401 of a request that was still running is the sign-out's own
    // doing: it must not send them to the login with the page they just left as the return path.
    signingOut = true;
    try {
      await api.signOut();
      forget();
    } finally {
      signingOut = false;
    }
  }

  const isSigningOut = (): boolean => signingOut;

  /**
   * The person changed their own name in the profile: the shells show it at once, without another
   * read of the session. Nothing else about the person can change this way.
   */
  function setDisplayName(displayName: string): void {
    if (user.value !== null) user.value = { ...user.value, displayName };
  }

  /**
   * The server no longer accepts the credentials (a 401 on any call): drop the person and every
   * per-person cache without another request. Returns false when nobody was signed in, so
   * several parallel 401s end the session once.
   */
  function expire(): boolean {
    if (user.value === null || signingOut) return false;
    forget();
    return true;
  }

  return {
    user: readonly(user),
    loadError: readonly(loadError),
    ensureLoaded,
    retry,
    reload,
    isSigningOut,
    signIn,
    signInWithPassword,
    signInWithTelegramWidget,
    signOut,
    expire,
    setDisplayName,
  };
}

export type CurrentUserStore = ReturnType<typeof createCurrentUserStore>;
