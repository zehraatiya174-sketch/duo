import { NextResponse } from 'next/server';

import { authedRoute, readJson, searchParamsToObject } from '@/lib/api/respond';
import { listMessagesSchema, sendMessageSchema } from '@/lib/validation/message';
import { createMessage, listMessages } from '@/services/messages';
import {
  broadcastMessageCreated,
  fanOutMessageNotifications,
  hydratePreviewsInBackground,
} from '@/socket/broadcast';
import { getSocketServer } from '@/socket/context';
import type { MessageDTO, Page } from '@/types/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One page of the timeline, newest first. */
export const GET = authedRoute<Record<string, never>, Page<MessageDTO>>(
  async ({ request, user }) => {
    const input = listMessagesSchema.parse(searchParamsToObject(request.url));
    return NextResponse.json<Page<MessageDTO>>(await listMessages(user.id, input));
  },
);

/**
 * The HTTP fallback for sending.
 *
 * The socket is the normal path; this covers the seconds around a reconnect.
 * The two must be interchangeable, so everything the socket handler does after
 * writing — broadcast, notifications, link previews — happens here too. A send
 * that took this route and produced no broadcast would arrive for the sender
 * and silently never reach the other person.
 *
 * Idempotent on `clientId`: a retry of a send whose response was lost resolves
 * to the original message instead of duplicating it.
 */
export const POST = authedRoute<Record<string, never>, MessageDTO>(async ({ request, user }) => {
  const input = sendMessageSchema.parse(await readJson(request));
  const result = await createMessage(user.id, input);

  if (result.deduplicated) {
    return NextResponse.json<MessageDTO>(result.message);
  }

  const io = getSocketServer();
  if (io) {
    broadcastMessageCreated(result, user.id, { io });

    await fanOutMessageNotifications({
      chatId: input.chatId,
      authorId: user.id,
      authorName: user.name,
      recipientIds: result.recipientIds,
      body: result.row.body,
      hasAttachment: result.row.attachments.length > 0,
      messageId: result.row.id,
      mentionedIds: (input.mentions ?? []).map((mention) => mention.userId),
    });

    hydratePreviewsInBackground(result.row.id, result.row.body, [user.id, ...result.recipientIds], {
      io,
    });
  }

  return NextResponse.json<MessageDTO>(result.message, { status: 201 });
});
