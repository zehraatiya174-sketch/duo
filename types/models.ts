import type {
  AttachmentKind,
  EphemeralMode,
  MessageStatus,
  MessageType,
  NotificationKind,
  PresenceStatus,
} from '@prisma/client';

export type {
  AttachmentKind,
  CallKind,
  CallStatus,
  EphemeralMode,
  FontSize,
  MediaAutoDownload,
  MessageStatus,
  MessageType,
  NotificationKind,
  PresenceStatus,
  ThemeMode,
  UserRole,
} from '@prisma/client';

/**
 * Wire-format models.
 *
 * These are the *only* shapes that cross the network. Dates are ISO strings so
 * a payload survives JSON round-tripping through Socket.IO and TanStack Query's
 * cache without a custom serializer, and storage keys never appear at all.
 */

export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  statusText: string | null;
  presence: PresenceStatus;
  /** Null when the user has hidden their last-seen time. */
  lastSeenAt: string | null;
}

export interface AttachmentDTO {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  waveform: number[];
  blurDataUrl: string | null;
  /** Short-lived signed path. Regenerated on every fetch; never persisted. */
  url: string | null;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  /** True once the blob has been destroyed by ephemeral expiry. */
  purged: boolean;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Whether the requesting user is part of this group. */
  reacted: boolean;
  userIds: string[];
}

export interface LinkPreviewDTO {
  id: string;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

/** The compact ancestor shown above a reply. */
export interface MessageReferenceDTO {
  id: string;
  authorId: string;
  authorName: string;
  type: MessageType;
  preview: string;
  deleted: boolean;
}

export interface EphemeralStateDTO {
  mode: EphemeralMode;
  maxViews: number | null;
  viewCount: number;
  /** Remaining opens for the *requesting* user. Null means unlimited. */
  remainingViews: number | null;
  expiresAt: string | null;
  destructAfterSeconds: number | null;
  destructStartedAt: string | null;
  /** True once the content is gone; the bubble renders a tombstone. */
  consumed: boolean;
  /**
   * True while the requesting user holds a live reservation — the look is
   * being taken right now and has not been charged yet.
   */
  viewing: boolean;
  /** True when the requesting user has never opened it. */
  unopened: boolean;
}

/**
 * What the server hands back when a reader reserves a look.
 *
 * The session id is the receipt: the client quotes it back to say the media
 * painted, and again when the viewer closes. Without it the server would have
 * to guess which look a late-arriving report belonged to.
 */
export interface EphemeralSessionDTO {
  message: MessageDTO;
  /** Null for the author's own message and for non-ephemeral content. */
  sessionId: string | null;
  leaseExpiresAt: string | null;
  remainingViews: number | null;
}

/** The result of settling a reserved look. */
export interface ViewSettlementDTO {
  messageId: string;
  state: 'RENDERED' | 'COMPLETED' | 'RELEASED';
  remainingViews: number | null;
  viewCount: number;
  /** True when settling this look destroyed the message for good. */
  purged: boolean;
}

export interface MessageDTO {
  id: string;
  clientId: string;
  chatId: string;
  authorId: string;
  type: MessageType;
  status: MessageStatus;
  /** Null when deleted, purged, or when ephemeral content is still sealed. */
  body: string | null;
  codeLanguage: string | null;
  location: { lat: number; lng: number; label: string | null } | null;

  replyTo: MessageReferenceDTO | null;
  forwardedFrom: MessageReferenceDTO | null;

  attachments: AttachmentDTO[];
  reactions: ReactionGroup[];
  linkPreviews: LinkPreviewDTO[];
  mentions: Array<{ userId: string; offset: number; length: number }>;

  ephemeral: EphemeralStateDTO | null;

  editedAt: string | null;
  editCount: number;
  deletedForAll: boolean;
  pinned: boolean;

  /** Populated for the author only. */
  deliveredAt: string | null;
  readAt: string | null;

  createdAt: string;
  updatedAt: string;
}

export interface ChatSummaryDTO {
  id: string;
  slug: string;
  title: string | null;
  wallpaperUrl: string | null;
  unreadCount: number;
  lastReadMessageId: string | null;
  muted: boolean;
  lastMessageAt: string;
  participants: PublicProfile[];
}

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TypingState {
  userId: string;
  chatId: string;
  typing: boolean;
}

export interface PresenceState {
  userId: string;
  presence: PresenceStatus;
  lastSeenAt: string | null;
}

/** A signed-in device, as shown on the security screen. */
export interface DeviceDTO {
  id: string;
  label: string;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  ipAddress: string | null;
  lastActiveAt: string;
  createdAt: string;
  /** True for the device making the request; it cannot revoke itself. */
  isCurrent: boolean;
  /** False once the session behind it has expired but the row remains. */
  sessionActive: boolean;
}

/**
 * WebRTC ICE configuration, handed out per session.
 *
 * Structurally identical to `RTCIceServer`, but declared here rather than
 * imported from the DOM lib because the route that produces it runs on the
 * server, where those types do not exist.
 */
export interface IceServerDTO {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfigDTO {
  iceServers: IceServerDTO[];
  /** False when no relay is configured; symmetric-NAT calls will fail. */
  hasTurn: boolean;
  /** `relay` pins every call to TURN; `all` lets ICE pick the direct path. */
  iceTransportPolicy: 'all' | 'relay';
  /** Lifetime of the issued TURN credential, in seconds. */
  ttlSeconds: number;
}

/** Cursor-paginated envelope used by every list endpoint. */
export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next (older) page. Null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
}
