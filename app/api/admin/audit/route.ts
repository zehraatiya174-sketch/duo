import { NextResponse } from 'next/server';
import { z } from 'zod';

import { adminRoute, searchParamsToObject } from '@/lib/api/respond';
import { type AuditLogRow, listAuditLogs } from '@/services/admin';
import type { Page } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  action: z
    .enum([
      'LOGIN_SUCCESS',
      'LOGIN_FAILURE',
      'LOGOUT',
      'LOGOUT_ALL',
      'REGISTER_BLOCKED',
      'PASSWORD_CHANGED',
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
      'PROFILE_UPDATED',
      'SETTINGS_UPDATED',
      'DEVICE_REVOKED',
      'MESSAGE_DELETED',
      'MESSAGE_EDITED',
      'EPHEMERAL_VIEWED',
      'EPHEMERAL_PURGED',
      'ATTACHMENT_UPLOADED',
      'ATTACHMENT_DOWNLOADED',
      'RATE_LIMITED',
      'SUSPICIOUS_ACTIVITY',
      'CALL_STARTED',
      'CALL_ENDED',
      'APP_SETTINGS_UPDATED',
      'DISAPPEARING_MODE_CHANGED',
      'MESSAGES_HIDDEN',
      'MESSAGES_RESTORED',
      'VERIFICATION_PASSED',
      'VERIFICATION_FAILED',
    ])
    .optional(),
});

export const GET = adminRoute<Record<string, never>, Page<AuditLogRow>>(async ({ request }) => {
  const query = querySchema.parse(searchParamsToObject(request.url));
  return NextResponse.json(await listAuditLogs(query), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
