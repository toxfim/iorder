import type {
  MeResponse,
  OrganizationRole,
  SetOwnContactRequest,
  StaffViewerInfo,
} from '@iorder/shared';
import { computed, readonly, ref, shallowRef } from 'vue';
import { PermissionDeniedError } from '@core/lib/api-errors';
import type { MeApi } from '../api/me-api';

/**
 * What the Mini App knows about the person. `denied` covers every cause on purpose (not in a
 * group, group not active, blocked, a company employee who may not use this app, unknown person):
 * the server answers all of them the same way and the screen must not help anyone probe which one
 * it is.
 */
export type SessionState = 'loading' | 'no-telegram' | 'denied' | 'error' | 'ready';

export interface CustomerSessionDeps {
  readonly meApi: MeApi;
  readonly readInitData: () => string | null;
  /** Called once with the answer of `/me`, for example to adopt the person's language. */
  readonly onMe?: (me: MeResponse) => void;
}

export function createCustomerSession(deps: CustomerSessionDeps) {
  const state = ref<SessionState>('loading');
  const me = shallowRef<MeResponse | null>(null);
  const error = shallowRef<unknown>(null);
  let run = 0;

  const organizationRole = computed<OrganizationRole | null>(
    () => me.value?.membership?.role ?? null,
  );

  /**
   * Set while a company employee uses the app as a viewer ([C] 2026-11-09): prices and the cart,
   * no organization. The SERVER says so in `/me`, together with whether an order can be placed
   * and where it goes; nothing here is worked out from roles.
   */
  const staffViewer = computed<StaffViewerInfo | null>(() => me.value?.staffViewer ?? null);

  /** The shop of a customer, or the organization a viewer's order is written to; else null. */
  const organizationName = computed<string | null>(
    () => me.value?.membership?.organizationName ?? staffViewer.value?.organizationName ?? null,
  );

  async function load(): Promise<void> {
    const mine = ++run;
    error.value = null;
    if (deps.readInitData() === null) {
      // Opened outside Telegram: there is nothing to send, so nothing is requested.
      state.value = 'no-telegram';
      return;
    }
    state.value = 'loading';
    try {
      const answer = await deps.meApi.getMe();
      if (mine !== run) return;
      // The customer app is for organization members and, as viewers, for the company's own
      // people the server names as such; anyone else sees the same screen as a person the server
      // turned away.
      const isViewer = answer.staffViewer !== undefined && answer.staffViewer !== null;
      const isMember = answer.membership !== null && answer.staffRoles.length === 0;
      if (!isViewer && !isMember) {
        state.value = 'denied';
        return;
      }
      me.value = answer;
      deps.onMe?.(answer);
      state.value = 'ready';
    } catch (caught) {
      if (mine !== run) return;
      error.value = caught;
      state.value = caught instanceof PermissionDeniedError ? 'denied' : 'error';
    }
  }

  /** True until the customer has entered a phone: the first order asks for it. */
  const needsContact = computed(() => me.value?.needsContact === true);

  /**
   * Saves the person's name and phone (first order, or an edit in the profile) and adopts the
   * answer: the next order does not ask again and every screen shows the new name at once.
   */
  async function setContact(request: SetOwnContactRequest): Promise<void> {
    me.value = await deps.meApi.setContact(request);
  }

  /** Re-reads `/me` without touching the screen state; a failure keeps what is known. */
  async function refreshMe(): Promise<void> {
    try {
      me.value = await deps.meApi.getMe();
    } catch {
      // The old answer stays; the next call that matters reports the real problem.
    }
  }

  /** Any later request answered 401: the membership ended while the app was open. */
  function markDenied(): void {
    run += 1;
    me.value = null;
    state.value = 'denied';
  }

  return {
    state: readonly(state),
    me: readonly(me),
    error: readonly(error),
    organizationRole,
    staffViewer,
    organizationName,
    needsContact,
    setContact,
    refreshMe,
    load,
    markDenied,
    signedOut: (): void => {
      run += 1;
      me.value = null;
      state.value = 'no-telegram';
    },
  };
}

export type CustomerSession = ReturnType<typeof createCustomerSession>;
