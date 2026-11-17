import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer loads .env itself. The file lives at the repo root; in CI the
// variables come from the environment and the file does not exist.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
