import { ZodError } from 'zod';

import { createLogger } from '@/lib/logger';
import { fromZodError, toAppError } from '@/lib/errors';
import type { Ack, AckFn } from '@/types/socket';

import type { DuoSocket } from '../context';

const log = createLogger('socket:handler');

/**
 * Acknowledgement constructors.
 *
 * Every socket call answers with this envelope rather than by rejecting, so the
 * client's `request()` has one shape to unwrap and a failure is never an
 * unhandled promise on the server.
 */
export const ack = {
  ok<T>(data: T): Ack<T> {
    return { status: 'ok', data };
  },

  fail<T = never>(code: string, message: string): Ack<T> {
    return { status: 'error', error: { code, message } };
  },
} as const;

/**
 * Wraps an async socket handler so that no thrown error can escape it.
 *
 * Three things this buys, all of which were otherwise repeated in every
 * listener:
 *
 * - An unhandled rejection inside a Socket.IO listener takes down the process.
 *   Here it becomes an `ack.fail` the client can show.
 * - Validation errors are translated once, so a `ZodError` reaches the user as
 *   the field message rather than as "Something went wrong".
 * - The caller is never left waiting: `respond` is guaranteed to be invoked
 *   exactly once, which is what stops `request()` hanging until its timeout.
 *
 * Internal detail is deliberately withheld from the client for unexpected
 * failures — the message is logged in full and the caller gets a generic one.
 */
export function guard<TPayload, TResult>(
  socket: DuoSocket,
  event: string,
  handler: (payload: TPayload, respond: AckFn<TResult>) => Promise<void>,
): (payload: TPayload, respond: AckFn<TResult>) => void {
  return (payload, respond) => {
    let answered = false;
    const respondOnce: AckFn<TResult> = (response) => {
      if (answered) return;
      answered = true;
      respond(response);
    };

    void handler(payload, respondOnce)
      .catch((error: unknown) => {
        if (error instanceof ZodError) {
          const appError = fromZodError(error);
          respondOnce(ack.fail(appError.code, appError.message));
          return;
        }

        const appError = toAppError(error);
        log.error('Socket handler failed', {
          event,
          userId: socket.data.auth?.userId,
          code: appError.code,
          error: appError.message,
        });

        respondOnce(
          appError.code === 'INTERNAL'
            ? ack.fail('INTERNAL', 'Something went wrong')
            : ack.fail(appError.code, appError.message),
        );
      })
      .finally(() => {
        // A handler that returned without answering would strand the client
        // until its 12s ack timeout; failing fast is more useful than that.
        if (!answered) {
          log.warn('Handler finished without responding', { event });
          respondOnce(ack.fail('INTERNAL', 'The server did not answer'));
        }
      });
  };
}
