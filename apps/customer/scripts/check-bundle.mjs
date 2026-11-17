// Fails if the customer production bundle breaks the shared bundle rules (packages/web-core/
// scripts/bundle-check.mjs): no fake data, no staff vocabulary in any chunk, no staff chunk.
// Run after a normal `vite build`: `pnpm --filter @iorder/customer check:bundle`.
import { fileURLToPath } from 'node:url';
import { runBundleCheck } from '../../../packages/web-core/scripts/bundle-check.mjs';

// CHECK_BUNDLE_DIST lets the test suite run this script against a small fixture directory.
const dist = process.env.CHECK_BUNDLE_DIST ?? fileURLToPath(new URL('../dist', import.meta.url));
runBundleCheck(dist, { staffApp: false });
