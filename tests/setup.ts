import { afterEach, vi } from 'vitest';

// --- Deterministic environment for every suite -----------------------------
// `NODE_ENV` is typed readonly, and Vitest already sets it to 'test'.
process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/duochat_test?schema=public';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-that-is-at-least-32-characters-long!!';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AUTHORIZED_USER_1 ??= 'alice@example.com';
process.env.AUTHORIZED_USER_2 ??= 'bob@example.com';
process.env.ADMIN_EMAIL ??= 'alice@example.com';
process.env.MEDIA_URL_SECRET ??= 'test-media-secret-that-is-32-chars-minimum!!';
process.env.MEDIA_ENCRYPTION_KEY ??= 'a'.repeat(64);
// No longer has a built-in default, so the suites have to state it themselves.
process.env.VERIFICATION_PASSPHRASE ??= 'sexy12';
process.env.STORAGE_PROVIDER ??= 'local';
process.env.RATE_LIMIT_ENABLED ??= 'false';
process.env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
process.env.NEXT_PUBLIC_APP_NAME ??= 'Duo';
process.env.NEXT_PUBLIC_SOCKET_PATH ??= '/api/socket';

/**
 * Server-side suites opt into the node environment with a `@vitest-environment
 * node` docblock, where none of the following exists. Everything DOM-shaped is
 * therefore imported dynamically and only under jsdom — a static import of
 * Testing Library would throw before the first assertion in those suites.
 */
const isBrowserLike = typeof window !== 'undefined' && typeof document !== 'undefined';

if (isBrowserLike) {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');

  afterEach(() => {
    cleanup();
  });

  // --- Browser APIs jsdom does not implement -------------------------------

  if (!globalThis.matchMedia) {
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof globalThis.matchMedia;
  }

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver ??=
    IntersectionObserverStub as unknown as typeof IntersectionObserver;

  globalThis.scrollTo ??= (() => {}) as typeof globalThis.scrollTo;
  Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};
  // jsdom implements neither, and the timeline scrolls itself to the newest
  // message on mount.
  Element.prototype.scrollTo ??= function scrollTo(): void {};

  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  }
}

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `uuid-${Math.random().toString(36).slice(2)}`,
    },
    configurable: true,
  });
}
