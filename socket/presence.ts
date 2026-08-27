import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';
import type { PresenceStatus } from '@/types/models';
import { SOCKET_ROOMS } from '@/types/socket';

import type { DuoServer } from './context';

const log = createLogger('socket:presence');

/**
 * Who is connected, and from how many devices.
 *
 * Process-local on purpose. The deployment runs exactly one replica — Socket.IO
 * has no Redis adapter here — so a `Map` is the whole truth. If a second replica
 * were ever added this would silently fragment, which is the same constraint
 * that forbids autoscaling in `railway.json` and `render.yaml`.
 */
const connections = new Map<string, Set<string>>();

/** `userId -> chatIds` the user is currently typing in. */
const typing = new Map<string, Set<string>>();

/**
 * Records a socket. Returns true when this is the user's first live connection,
 * which is what distinguishes "came online" from "opened a second tab" — only
 * the former deserves a presence broadcast.
 */
export function trackConnection(userId: string, socketId: string): boolean {
  const sockets = connections.get(userId);
  if (sockets) {
    sockets.add(socketId);
    return false;
  }
  connections.set(userId, new Set([socketId]));
  return true;
}

/** Returns true when the last connection for that user has gone. */
export function untrackConnection(userId: string, socketId: string): boolean {
  const sockets = connections.get(userId);
  if (!sockets) return false;

  sockets.delete(socketId);
  if (sockets.size > 0) return false;

  connections.delete(userId);
  return true;
}

export function isOnline(userId: string): boolean {
  return connections.has(userId);
}

export function onlineUserIds(): string[] {
  return [...connections.keys()];
}

/** Total open sockets across every user — the admin console's live figure. */
export function connectionCount(): number {
  let total = 0;
  for (const sockets of connections.values()) total += sockets.size;
  return total;
}

/**
 * Writes presence to the database and tells the other person.
 *
 * `lastSeenAt` is only advanced on the way *out*: it answers "when were they
 * last here", so refreshing it while someone is online would make the label
 * read "last seen just now" for a person who is still connected.
 */
export async function publishPresence(
  io: DuoServer,
  userId: string,
  presence: PresenceStatus,
): Promise<void> {
  const lastSeenAt = presence === 'OFFLINE' ? new Date() : undefined;

  try {
    const profile = await db.profile.update({
      where: { userId },
      data: { presence, ...(lastSeenAt ? { lastSeenAt } : {}) },
      select: { lastSeenAt: true },
    });

    io.emit('presence:update', {
      userId,
      presence,
      lastSeenAt: profile.lastSeenAt?.toISOString() ?? null,
    });
  } catch (error) {
    // A presence write failing must not take the connection down with it.
    log.warn('Could not publish presence', { userId, presence, error });
  }
}

/**
 * Broadcasts a typing change to the rest of the room.
 *
 * State is tracked per chat so that disconnecting can retract every indicator
 * the user left behind — without that, closing a laptop mid-sentence leaves the
 * other person watching "typing…" forever.
 */
export function setTyping(
  io: DuoServer,
  userId: string,
  chatId: string,
  isTyping: boolean,
): void {
  const chats = typing.get(userId) ?? new Set<string>();

  if (isTyping) chats.add(chatId);
  else chats.delete(chatId);

  if (chats.size > 0) typing.set(userId, chats);
  else typing.delete(userId);

  io.to(SOCKET_ROOMS.chat(chatId)).emit('typing:update', { userId, chatId, typing: isTyping });
}

/** Retracts every outstanding indicator for a user. Called on disconnect. */
export function clearTypingForUser(io: DuoServer, userId: string): void {
  const chats = typing.get(userId);
  if (!chats) return;

  for (const chatId of chats) {
    io.to(SOCKET_ROOMS.chat(chatId)).emit('typing:update', { userId, chatId, typing: false });
  }
  typing.delete(userId);
}
