import type {
  EphemeralSessionDTO,
  MessageDTO,
  NotificationDTO,
  PresenceState,
  ReactionGroup,
  TypingState,
  ViewSettlementDTO,
} from './models';

/**
 * The realtime contract.
 *
 * Every event is declared here once and consumed by both the server and the
 * browser, so a rename cannot silently desynchronise the two halves.
 */

export interface SocketAuthPayload {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
}

export type AckStatus = 'ok' | 'error';

export interface Ack<T> {
  status: AckStatus;
  data?: T;
  error?: { code: string; message: string };
}

export type AckFn<T> = (response: Ack<T>) => void;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export interface SendMessagePayload {
  /** Client-generated idempotency key. Re-sends with the same id are no-ops. */
  clientId: string;
  chatId: string;
  type: MessageDTO['type'];
  body?: string;
  codeLanguage?: string;
  replyToId?: string;
  forwardedFromId?: string;
  attachmentIds?: string[];
  location?: { lat: number; lng: number; label?: string };
  ephemeral?: {
    mode: MessageDTO['ephemeral'] extends null
      ? never
      : NonNullable<MessageDTO['ephemeral']>['mode'];
    maxViews?: number | null;
    expiresInSeconds?: number | null;
    destructAfterSeconds?: number | null;
  };
  mentions?: Array<{ userId: string; offset: number; length: number }>;
}

export interface EditMessagePayload {
  messageId: string;
  body: string;
}

export interface DeleteMessagePayload {
  messageId: string;
  scope: 'me' | 'everyone';
}

export interface ReactPayload {
  messageId: string;
  emoji: string;
}

export interface TypingPayload {
  chatId: string;
  typing: boolean;
}

export interface ReceiptPayload {
  chatId: string;
  messageIds: string[];
}

export interface EphemeralOpenPayload {
  messageId: string;
}

/** Quotes back the receipt from `ephemeral:open` to settle that look. */
export interface EphemeralSettlePayload {
  messageId: string;
  sessionId: string;
  /** Only meaningful when releasing; recorded for the audit trail. */
  reason?: string;
}

export interface EphemeralSuspicionPayload {
  messageId: string;
  /** What the client observed: focus loss, print attempt, or screen capture API. */
  reason: 'visibility' | 'blur' | 'print' | 'capture-api';
}

export interface CallInvitePayload {
  chatId: string;
  kind: 'AUDIO' | 'VIDEO' | 'SCREEN_SHARE';
  /** RTCSessionDescriptionInit, structurally typed to avoid a DOM lib dependency on the server. */
  sdp: { type: string; sdp?: string };
}

export interface CallAnswerPayload {
  callId: string;
  sdp: { type: string; sdp?: string };
}

export interface CallIcePayload {
  callId: string;
  candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
}

export interface CallEndPayload {
  callId: string;
  reason?: string;
}

export interface CallStatsPayload {
  callId: string;
  stats: {
    rttMs?: number;
    jitterMs?: number;
    packetsLost?: number;
    bitrateKbps?: number;
  };
}

export interface CallRenegotiatePayload {
  callId: string;
  sdp: { type: string; sdp?: string };
}

export interface ClientToServerEvents {
  'message:send': (payload: SendMessagePayload, ack: AckFn<MessageDTO>) => void;
  'message:edit': (payload: EditMessagePayload, ack: AckFn<MessageDTO>) => void;
  'message:delete': (payload: DeleteMessagePayload, ack: AckFn<{ messageId: string }>) => void;
  'message:react': (
    payload: ReactPayload,
    ack: AckFn<{ messageId: string; reactions: ReactionGroup[] }>,
  ) => void;
  'message:pin': (
    payload: { messageId: string; pinned: boolean },
    ack: AckFn<{ messageId: string; pinned: boolean }>,
  ) => void;

  'typing:set': (payload: TypingPayload) => void;

  'receipt:delivered': (payload: ReceiptPayload) => void;
  'receipt:read': (payload: ReceiptPayload, ack?: AckFn<{ unreadCount: number }>) => void;

  'ephemeral:open': (payload: EphemeralOpenPayload, ack: AckFn<EphemeralSessionDTO>) => void;
  /** The media painted; from here the look can no longer be handed back. */
  'ephemeral:rendered': (
    payload: EphemeralSettlePayload,
    ack: AckFn<ViewSettlementDTO | null>,
  ) => void;
  /** The viewer closed; charge the look and destroy if it was the last one. */
  'ephemeral:complete': (
    payload: EphemeralSettlePayload,
    ack: AckFn<ViewSettlementDTO | null>,
  ) => void;
  /** Nothing was ever shown; hand the look back if the budget allows. */
  'ephemeral:release': (
    payload: EphemeralSettlePayload,
    ack: AckFn<ViewSettlementDTO | null>,
  ) => void;
  'ephemeral:suspicion': (payload: EphemeralSuspicionPayload) => void;

  'presence:set': (payload: { presence: PresenceState['presence'] }) => void;
  /** Round-trip latency probe used by the connection-quality indicator. */
  'presence:ping': (sentAt: number, ack: AckFn<{ sentAt: number; serverTime: number }>) => void;

  'chat:join': (payload: { chatId: string }, ack: AckFn<{ chatId: string }>) => void;
  /** Replays everything the client missed while it was disconnected. */
  'sync:since': (
    payload: { chatId: string; since: string },
    ack: AckFn<{ messages: MessageDTO[] }>,
  ) => void;

  'call:invite': (payload: CallInvitePayload, ack: AckFn<{ callId: string }>) => void;
  'call:answer': (payload: CallAnswerPayload, ack: AckFn<{ callId: string }>) => void;
  'call:ice': (payload: CallIcePayload) => void;
  'call:renegotiate': (payload: CallRenegotiatePayload) => void;
  /** The callee's device has the invite and is alerting. Purely informational. */
  'call:ringing': (payload: { callId: string }) => void;
  /**
   * Asks the *caller* to restart ICE. Only the offerer may re-offer, so a
   * callee that notices the media path has died has to ask rather than act.
   */
  'call:restart': (payload: { callId: string; reason?: string }) => void;
  'call:decline': (payload: CallEndPayload) => void;
  'call:end': (payload: CallEndPayload) => void;
  'call:stats': (payload: CallStatsPayload) => void;
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'message:new': (message: MessageDTO) => void;
  'message:updated': (message: MessageDTO) => void;
  'message:deleted': (payload: {
    messageId: string;
    chatId: string;
    scope: 'me' | 'everyone';
  }) => void;
  'message:reaction': (payload: {
    messageId: string;
    chatId: string;
    reactions: ReactionGroup[];
  }) => void;
  'message:pinned': (payload: { messageId: string; chatId: string; pinned: boolean }) => void;

  'receipt:update': (payload: {
    chatId: string;
    messageIds: string[];
    userId: string;
    kind: 'delivered' | 'read';
    at: string;
  }) => void;

  'typing:update': (state: TypingState) => void;
  'presence:update': (state: PresenceState) => void;

  'unread:update': (payload: { chatId: string; unreadCount: number }) => void;

  'ephemeral:viewed': (payload: {
    messageId: string;
    chatId: string;
    viewerId: string;
    viewCount: number;
    remainingViews: number | null;
    at: string;
  }) => void;
  'ephemeral:purged': (payload: { messageId: string; chatId: string }) => void;
  'ephemeral:suspicion': (payload: {
    messageId: string;
    chatId: string;
    viewerId: string;
    reason: EphemeralSuspicionPayload['reason'];
    at: string;
  }) => void;

  'notification:new': (notification: NotificationDTO) => void;

  'call:incoming': (payload: {
    callId: string;
    chatId: string;
    from: string;
    kind: CallInvitePayload['kind'];
    sdp: { type: string; sdp?: string };
  }) => void;
  'call:answered': (payload: { callId: string; sdp: { type: string; sdp?: string } }) => void;
  'call:ice': (payload: CallIcePayload) => void;
  'call:renegotiate': (payload: CallRenegotiatePayload) => void;
  /** The other device is alerting — the caller can stop saying "Calling…". */
  'call:ringing': (payload: { callId: string; by: string }) => void;
  /** A peer is asking the offerer to restart ICE. */
  'call:restart': (payload: { callId: string; by: string; reason?: string }) => void;
  'call:ended': (payload: { callId: string; reason: string; by: string }) => void;
  'call:declined': (payload: { callId: string; by: string }) => void;

  /**
   * An instance-wide setting changed. The payload is deliberately thin: the
   * client refetches rather than trusting a pushed copy, so a stale socket can
   * never leave one device showing a history the admin has withdrawn.
   */
  'settings:updated': (payload: { disappearingMode: boolean; historyHidden: boolean }) => void;

  /** Forces the client to drop its session — used when an account is revoked. */
  'session:revoked': (payload: { reason: string }) => void;

  'server:error': (payload: { code: string; message: string }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

/** Per-connection state attached by the auth middleware. */
export interface SocketData {
  auth: SocketAuthPayload;
  /** Chat rooms this socket has joined, for cheap membership checks. */
  chats: Set<string>;
  connectedAt: number;
}

export const SOCKET_ROOMS = {
  user: (userId: string) => `user:${userId}`,
  chat: (chatId: string) => `chat:${chatId}`,
} as const;
