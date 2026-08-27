import type { AttachmentDTO, MessageDTO, MessageReferenceDTO } from '@/types/models';
import type { SendMessagePayload } from '@/types/socket';

/**
 * Idempotency key for a send.
 *
 * The server treats a repeat of the same id as a no-op, which is what makes
 * retrying a send whose acknowledgement was lost safe. `randomUUID` is present
 * in every browser this app supports and in Node; the fallback exists only for
 * the jsdom suites, where the shim is installed per-file.
 */
export function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface OptimisticContext {
  authorId: string;
  attachments?: AttachmentDTO[];
  replyTo?: MessageReferenceDTO;
}

/**
 * The placeholder bubble shown between pressing send and the server answering.
 *
 * Every field the timeline reads has to be present and plausible, because this
 * object is rendered by exactly the same component as a real message. Anything
 * only the server can decide — delivery receipts, link previews, the real id —
 * is left empty rather than guessed: showing a tick that has not been earned is
 * worse than showing none.
 *
 * `id` is set to the `clientId` so the row has a stable React key; the server's
 * copy replaces it wholesale on arrival.
 */
export function buildOptimisticMessage(
  payload: SendMessagePayload,
  context: OptimisticContext,
): MessageDTO {
  const now = new Date().toISOString();

  return {
    id: payload.clientId,
    clientId: payload.clientId,
    chatId: payload.chatId,
    authorId: context.authorId,
    type: payload.type,
    status: 'PENDING',
    body: payload.body ?? null,
    codeLanguage: payload.codeLanguage ?? null,
    location: payload.location
      ? {
          lat: payload.location.lat,
          lng: payload.location.lng,
          label: payload.location.label ?? null,
        }
      : null,

    replyTo: context.replyTo ?? null,
    forwardedFrom: null,

    attachments: context.attachments ?? [],
    reactions: [],
    linkPreviews: [],
    mentions: payload.mentions ?? [],

    // The sender's own view of a sealed message is never sealed — the seal is
    // applied for the recipient when the server serialises it.
    ephemeral: null,

    editedAt: null,
    editCount: 0,
    deletedForAll: false,
    pinned: false,

    deliveredAt: null,
    readAt: null,

    createdAt: now,
    updatedAt: now,
  };
}
