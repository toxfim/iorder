import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// The source audits (colours, dark mode) hold for every frontend package, not only this one, so
// they scan the kit and each app from here.
// Vitest runs in the package folder (packages/<name> or apps/<name>), two levels below the root.
// Under jsdom import.meta.url is not a file URL, so it cannot locate the repository.
export const REPO_ROOT = resolve(process.cwd(), '../..');
export const FRONTEND_SOURCE_ROOTS: readonly string[] = [
  'packages/web-core/src',
  'apps/staff/src',
  'apps/customer/src',
];
export const TOKENS_FILE = 'packages/web-core/src/styles/tokens.css';

/** Forward-slash path relative to the repository root. */
export function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

/** Every file under the frontend roots whose name passes `keep` (test-utils and generated skipped). */
export function listFrontendFiles(keep: (name: string) => boolean): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'generated' || entry.name === 'test-utils' ? [] : walk(path);
      }
      return keep(entry.name) ? [path] : [];
    });
  return FRONTEND_SOURCE_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));
}
