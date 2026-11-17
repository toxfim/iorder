// Fails if the staff production bundle breaks the shared bundle rules (packages/web-core/scripts/
// bundle-check.mjs). Run after a normal `vite build`: `pnpm --filter @iorder/staff check:bundle`.
import { fileURLToPath } from 'node:url';
import { runBundleCheck } from '../../../packages/web-core/scripts/bundle-check.mjs';

// CHECK_BUNDLE_DIST lets the test suite run this script against a small fixture directory.
const dist = process.env.CHECK_BUNDLE_DIST ?? fileURLToPath(new URL('../dist', import.meta.url));
runBundleCheck(dist, { staffApp: true });
