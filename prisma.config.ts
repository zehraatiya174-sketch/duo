import path from 'node:path';

import { defineConfig } from 'prisma/config';

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
