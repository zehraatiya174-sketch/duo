import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { serverEnv } from './env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: string;
  tag: string;
}

function encryptionKey(): Buffer | null {
  const key = serverEnv().MEDIA_ENCRYPTION_KEY;
  return key ? Buffer.from(key, 'hex') : null;
}

export function mediaEncryptionEnabled(): boolean {
  return encryptionKey() !== null;
}

/**
 * AES-256-GCM. Returns the raw ciphertext plus the IV and auth tag as hex, to
 * be persisted alongside the object (see Attachment.encryptionIv/Tag).
 */
export function encryptBuffer(plaintext: Buffer): EncryptedBlob {
  const key = encryptionKey();
  if (!key) {
    throw new Error('encryptBuffer() called without MEDIA_ENCRYPTION_KEY configured');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

export function decryptBuffer(ciphertext: Buffer, ivHex: string, tagHex: string): Buffer {
  const key = encryptionKey();
  if (!key) {
    throw new Error('decryptBuffer() called without MEDIA_ENCRYPTION_KEY configured');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  const tag = Buffer.from(tagHex, 'hex');
  if (tag.length !== TAG_BYTES) {
    throw new Error('Invalid authentication tag length');
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison that tolerates unequal lengths without leaking. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so timing does not reveal the length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Signed media URLs
// ---------------------------------------------------------------------------

export interface MediaUrlClaims {
  attachmentId: string;
  userId: string;
  /** Unix seconds. */
  exp: number;
  /** `inline` for viewing, `attachment` for downloads. */
  disposition: 'inline' | 'attachment';
  /** Optional derivative, e.g. 'thumb'. */
  variant?: string;
}

function claimsPayload(claims: MediaUrlClaims): string {
  return [
    claims.attachmentId,
    claims.userId,
    String(claims.exp),
    claims.disposition,
    claims.variant ?? '',
  ].join('|');
}

export function signMediaClaims(claims: MediaUrlClaims): string {
  return createHmac('sha256', serverEnv().MEDIA_URL_SECRET)
    .update(claimsPayload(claims))
    .digest('base64url');
}

/**
 * Builds a short-lived, per-user, per-attachment signed path. Signatures are
 * bound to the requesting user so a leaked URL is useless to the other party.
 */
export function createSignedMediaPath(
  claims: Omit<MediaUrlClaims, 'exp'> & { ttlSeconds?: number },
): string {
  const ttl = claims.ttlSeconds ?? serverEnv().MEDIA_URL_TTL_SECONDS;
  const full: MediaUrlClaims = {
    attachmentId: claims.attachmentId,
    userId: claims.userId,
    disposition: claims.disposition,
    variant: claims.variant,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const params = new URLSearchParams({
    exp: String(full.exp),
    d: full.disposition,
    sig: signMediaClaims(full),
  });
  if (full.variant) params.set('v', full.variant);
  return `/api/media/${encodeURIComponent(full.attachmentId)}?${params.toString()}`;
}

export type MediaSignatureResult =
  { valid: true } | { valid: false; reason: 'expired' | 'bad-signature' };

export function verifyMediaSignature(
  claims: MediaUrlClaims,
  signature: string,
): MediaSignatureResult {
  if (claims.exp * 1000 < Date.now()) return { valid: false, reason: 'expired' };
  if (!safeEqual(signMediaClaims(claims), signature)) {
    return { valid: false, reason: 'bad-signature' };
  }
  return { valid: true };
}

/** URL-safe random identifier, e.g. for storage keys and client ids. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
