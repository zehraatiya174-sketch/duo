import { type Mock, vi } from 'vitest';

/**
 * An in-memory stand-in for the Prisma client.
 *
 * The suites that exercise services are about *decisions* — who may open a
 * sealed message, what gets purged, which branch a query result leads to — and
 * those decisions live in TypeScript, not in Postgres. Mocking the client keeps
 * them fast and hermetic; the queries themselves are covered by the E2E run,
 * which talks to a real database.
 */

export type ModelMock = Record<(typeof MODEL_METHODS)[number], Mock>;

const MODEL_METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

function model(): ModelMock {
  const entries = MODEL_METHODS.map((method) => [method, vi.fn()] as const);
  return Object.fromEntries(entries) as ModelMock;
}

export function createPrismaMock() {
  const mock = {
    user: model(),
    profile: model(),
    account: model(),
    session: model(),
    verification: model(),
    device: model(),
    chat: model(),
    chatMember: model(),
    message: model(),
    messageDeletion: model(),
    receipt: model(),
    messageView: model(),
    reaction: model(),
    mention: model(),
    pinnedMessage: model(),
    linkPreview: model(),
    attachment: model(),
    call: model(),
    callParticipant: model(),
    userSettings: model(),
    notification: model(),
    auditLog: model(),
    errorLog: model(),
    appSetting: model(),
    rateLimitBucket: model(),

    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $disconnect: vi.fn(),

    /**
     * Interactive transactions run their callback against the same mock, so a
     * test can assert on `tx.message.update` exactly as it would on a direct
     * call. Array form resolves the promises, matching Prisma's batch mode.
     */
    $transaction: vi.fn(async (arg: unknown): Promise<unknown> => {
      if (typeof arg === 'function') {
        return (arg as (tx: typeof mock) => unknown | Promise<unknown>)(mock);
      }
      return Promise.all(arg as Array<Promise<unknown>>);
    }),
  };

  return mock;
}

export type PrismaMock = ReturnType<typeof createPrismaMock>;

/** Resets every recorded call and implementation without rebuilding the mock. */
export function resetPrismaMock(mock: PrismaMock): void {
  for (const value of Object.values(mock)) {
    if (typeof value === 'function') {
      (value as Mock).mockReset();
      continue;
    }
    for (const method of Object.values(value)) method.mockReset();
  }

  mock.$transaction.mockImplementation(async (arg: unknown): Promise<unknown> => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown | Promise<unknown>)(mock);
    }
    return Promise.all(arg as Array<Promise<unknown>>);
  });
}
