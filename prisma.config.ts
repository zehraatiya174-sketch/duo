import path from 'node:path';

import { loadEnvConfig } from '@next/env';
import { defineConfig } from 'prisma/config';

/**
 * The presence of this file makes Prisma stop loading `.env` by itself, so it
 * has to be done here or every `prisma` command sees an undefined
 * `DATABASE_URL` and refuses to run.
 *
 * `@next/env` rather than `dotenv` deliberately: it is the same loader
 * `server/index.ts` uses, so the CLI and the running app resolve the
 * environment identically — including `.env.local` precedence. It only fills
 * variables that are currently undefined, so a real `DATABASE_URL` already in
 * the environment still wins.
 */
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

/**
 * Prisma 6+ configuration. Replaces the deprecated `package.json#prisma` key.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
