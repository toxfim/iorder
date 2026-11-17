import type { CustomerSiteApi } from './customer-site-api';

// Dev and test only (loaded through fake-services.ts). The demo has no server to issue a code, so
// the "handoff" opens the customer dev server as its demo viewer.
const DEMO_CUSTOMER_SITE = 'http://localhost:5174';

export function createFakeCustomerSiteApi(): CustomerSiteApi {
  return {
    getSite: () => Promise.resolve(DEMO_CUSTOMER_SITE),
    requestHandoff: () => Promise.resolve(`${DEMO_CUSTOMER_SITE}/#tgWebAppData=fake-viewer`),
  };
}
