import type { Services } from './services';

// Swapped in for fake-services.ts by the alias in vite.config.ts when fakes are disabled, so the
// real module (and its demo identities) is never part of the module graph of a production build.
export function createFakeServices(): Services {
  throw new Error('The fake API is disabled in this build');
}
