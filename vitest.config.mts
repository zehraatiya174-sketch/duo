import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: false,
    /**
     * jsdom by default because most suites render components. Server-side
     * suites opt out with a `@vitest-environment node` docblock — several of
     * them import `@node-rs/argon2` or `sharp`, native addons that cannot load
     * under jsdom.
     */
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Playwright owns these; running them under Vitest would start a browser
    // from inside a unit test run.
    exclude: ['tests/e2e/**', 'node_modules/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['lib/**', 'services/**', 'socket/**', 'hooks/**', 'utils/**'],
      exclude: ['**/*.d.ts', '**/types/**'],
    },
  },
});
