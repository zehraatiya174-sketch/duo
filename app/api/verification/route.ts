import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { authedRoute, readJson } from '@/lib/api/respond';
import {
  VERIFICATION_COOKIE,
  issueTicket,
  passphraseMatches,
  verificationRequired,
} from '@/lib/auth/verification';
import { db } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({ passphrase: z.string().min(1).max(256) });

interface VerificationResult {
  verified: boolean;
}

/**
 * The second gate.
 *
 * Rate-limited like a sign-in attempt, because that is what it is: without a
 * limit a six-character phrase would fall to a script in seconds. Both outcomes
 * are recorded in the audit trail, so a run of failures is visible afterwards.
 */
export const POST = authedRoute<Record<string, never>, VerificationResult>(
  async ({ request, user }) => {
    const { passphrase } = bodySchema.parse(await readJson(request));

    if (!verificationRequired()) {
      return NextResponse.json<VerificationResult>({ verified: true });
    }

    if (!passphraseMatches(passphrase)) {
      await db.auditLog.create({
        data: { userId: user.id, action: 'VERIFICATION_FAILED', metadata: {} },
      });
      // Deliberately says nothing about what was wrong with it.
      throw new AppError('UNAUTHORIZED', 'That passphrase is not correct');
    }

    const ticket = issueTicket(user.id);
    const store = await cookies();
    store.set(VERIFICATION_COOKIE, ticket.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: serverEnv().NODE_ENV === 'production',
      path: '/',
      maxAge: ticket.maxAge,
    });

    await db.auditLog.create({
      data: { userId: user.id, action: 'VERIFICATION_PASSED', metadata: {} },
    });

    return NextResponse.json<VerificationResult>({ verified: true });
  },
  { rateLimit: 'verification', skipVerification: true },
);

/** Drops the ticket, so the gate is asked again on the next page load. */
export const DELETE = authedRoute<Record<string, never>, VerificationResult>(
  async () => {
    const store = await cookies();
    store.delete(VERIFICATION_COOKIE);
    return NextResponse.json<VerificationResult>({ verified: false });
  },
  { skipVerification: true },
);
