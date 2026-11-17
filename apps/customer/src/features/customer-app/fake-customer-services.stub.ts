import type { CustomerServices } from './services';

// Swapped in for fake-customer-services.ts by the alias in vite.config.ts when fakes are
// disabled, so the fixtures never become part of a production build's module graph.
export function createFakeCustomerServices(): CustomerServices {
  throw new Error('The fake API is disabled in this build');
}
