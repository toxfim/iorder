import { customerCredentialsRequestSchema, type MeResponse } from '@iorder/shared';
import { forgetInitData, readInitData } from '@core/telegram/launch';
import { UnauthenticatedError } from '@core/lib/api-errors';
import { systemClock } from '@core/lib/business-clock';
import { createFakeCustomerBackend } from './api/fake-customer-backend';
import { assembleCustomerServices } from './assemble-services';
import type { CustomerServices } from './services';

// Only ever loaded through the dynamic import in create-customer-services.ts, behind the
// dev/flag gate. In dev open `/#tgWebAppData=fake-owner` on the customer dev server (or fake-seller,
// fake-other-org, fake-inactive-org, fake-staff, and the staff viewers fake-viewer and
// fake-viewer-ordering; any other value is an unknown person).
export function createFakeCustomerServices(onMe?: (me: MeResponse) => void): CustomerServices {
  let websiteIdentity: string | null = null;
  const credentials = new Map<string, { identity: string; hash: string }>();
  const identity = (): string | null => readInitData() ?? websiteIdentity;
  async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const backend = createFakeCustomerBackend({
    clock: systemClock,
    initData: identity,
    latencyMs: 250,
  });
  return {
    ...assembleCustomerServices(backend, onMe, identity),
    auth: {
      password: async (login, password) => {
        const found = credentials.get(login.trim().toLowerCase());
        if (!found || found.hash !== (await digest(password))) throw new UnauthenticatedError();
        websiteIdentity = found.identity;
        forgetInitData();
      },
      telegram: async () => {
        throw new UnauthenticatedError();
      },
      // The demo has no other site: no code is ever valid and nobody is sent anywhere.
      handoff: async () => {
        throw new UnauthenticatedError();
      },
      handoffPage: async () => null,
      revokeSession: async () => undefined,
      credentials: async () => {
        const current = identity();
        return {
          login: [...credentials].find(([, value]) => value.identity === current)?.[0] ?? null,
          canEdit: readInitData() !== null,
        };
      },
      setCredentials: async (input) => {
        const validated = customerCredentialsRequestSchema.parse(input);
        const current = readInitData();
        if (!current) throw new UnauthenticatedError();
        const found = credentials.get(validated.login);
        if (found && found.identity !== current) throw new UnauthenticatedError();
        for (const [login, value] of credentials)
          if (value.identity === current) credentials.delete(login);
        credentials.set(validated.login, {
          identity: current,
          hash: await digest(validated.password),
        });
        return { login: validated.login, canEdit: true };
      },
      logout: async () => {
        websiteIdentity = null;
        forgetInitData();
      },
    },
  };
}
