import type { AttachmentDTO, MessageDTO, PublicProfile } from '@/types/models';

/**
 * Fixed identities for the two participants.
 *
 * Stable literals rather than generated ids: a failing assertion that names
 * `usr_alice` is readable, and one that names `cm3x9f2…` is not. They are also
 * deliberately ordered — `ALICE` sorts before `BOB` — so any test that depends
 * on member ordering is deterministic.
 */
export const ALICE = 'usr_alice000000000000000';
export const BOB = 'usr_bob0000000000000000';

export const CHAT_ID = 'cht_duo00000000000000000';

/**
 * A complete `MessageDTO` with every field populated to a sane default.
 *
 * Tests override only the fields they are actually asserting on. Returning a
 * whole object rather than a partial is the point: the timeline renders real
 * DTOs, and a fixture missing `reactions` would fail inside the component
 * rather than in the assertion, which tells you nothing about what broke.
 */
export function messageDto(overrides: Partial<MessageDTO> = {}): MessageDTO {
  const createdAt = overrides.createdAt ?? '2026-01-01T12:00:00.000Z';

  return {
    id: 'msg_00000000000000000000',
    clientId: 'client-0',
    chatId: CHAT_ID,
    authorId: ALICE,
    type: 'TEXT',
    status: 'SENT',
    body: 'Hello',
    codeLanguage: null,
    location: null,

    replyTo: null,
    forwardedFrom: null,

    attachments: [],
    reactions: [],
    linkPreviews: [],
    mentions: [],

    ephemeral: null,

    editedAt: null,
    editCount: 0,
    deletedForAll: false,
    pinned: false,

    deliveredAt: null,
    readAt: null,

    createdAt,
    updatedAt: createdAt,

    ...overrides,
  };
}

export function profileDto(overrides: Partial<PublicProfile> = {}): PublicProfile {
  return {
    userId: ALICE,
    username: 'alice',
    displayName: 'Alice',
    bio: null,
    avatarUrl: null,
    statusText: null,
    presence: 'ONLINE',
    lastSeenAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

export function attachmentDto(overrides: Partial<AttachmentDTO> = {}): AttachmentDTO {
  return {
    id: 'att_00000000000000000000',
    kind: 'IMAGE',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    byteSize: 1024,
    width: 800,
    height: 600,
    duration: null,
    waveform: [],
    blurDataUrl: null,
    url: 'https://example.invalid/photo.jpg',
    thumbnailUrl: null,
    downloadUrl: null,
    purged: false,
    ...overrides,
  };
}
