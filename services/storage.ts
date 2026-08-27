import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentKind, StorageProvider } from '@prisma/client';

import type { AttachmentDTO } from '@/types/models';

import {
  createSignedMediaPath,
  decryptBuffer,
  encryptBuffer,
  mediaEncryptionEnabled,
  randomId,
  sha256,
} from '@/lib/crypto';
import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { type ServerEnv, serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('storage');

// ---------------------------------------------------------------------------
// MIME classification
// ---------------------------------------------------------------------------

const ARCHIVE_MIMES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
]);

const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

/** Types we will never accept, regardless of extension. */
const BLOCKED_MIMES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
  'text/html',
  'image/svg+xml', // SVG is a script execution vector.
]);

export function classifyMime(mimeType: string, fileName: string): AttachmentKind {
  // Resolve first: a picker that handed over `''` or `application/octet-stream`
  // for a `.mkv` would otherwise have it filed as OTHER rather than VIDEO.
  const mime = resolveMimeType(mimeType, fileName);
  if (mime === 'image/gif') return 'GIF';
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (ARCHIVE_MIMES.has(mime)) return 'ARCHIVE';
  if (DOCUMENT_MIMES.has(mime)) return 'DOCUMENT';

  const ext = path.extname(fileName).toLowerCase();
  if (['.zip', '.7z', '.rar', '.tar', '.gz'].includes(ext)) return 'ARCHIVE';
  if (
    ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv'].includes(ext)
  ) {
    return 'DOCUMENT';
  }
  return 'OTHER';
}

/**
 * Extensions that decide the type when the browser could not.
 *
 * Pickers hand over `''` or `application/octet-stream` for anything the OS has
 * no association for — `.mkv` being the common one — and classifying those as
 * `OTHER` would file a video as a generic download.
 */
const EXTENSION_MIMES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

/**
 * Extensions refused whatever they claim to be.
 *
 * The check has to be on the *name*, not the declared type: a browser reports
 * `application/octet-stream` for an unknown file, and an SVG or an `.exe`
 * uploaded that way would otherwise sail past the MIME blocklist. SVG is here
 * because it executes script when opened, not because it is a bad image.
 */
const BLOCKED_EXTENSIONS = new Set([
  '.svg',
  '.html',
  '.htm',
  '.xhtml',
  '.exe',
  '.dll',
  '.scr',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.sh',
  '.bash',
  '.ps1',
  '.jar',
  '.app',
]);

/**
 * The type a file should be treated as.
 *
 * The declared type wins when it says anything meaningful; otherwise the
 * extension decides. Never guesses from the bytes — sniffing content is what
 * turns "an image the sender chose" into "whatever the parser thought".
 */
export function resolveMimeType(mimeType: string, fileName: string): string {
  const declared = mimeType.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;

  const ext = path.extname(fileName).toLowerCase();
  // A file nothing recognises is a byte stream, stated explicitly rather than
  // left as the empty string every caller would then have to special-case.
  return EXTENSION_MIMES[ext] ?? 'application/octet-stream';
}

export function assertMimeAllowed(mimeType: string, fileName = ''): void {
  const ext = path.extname(fileName).toLowerCase();
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Files ending in ${ext} are not accepted`);
  }

  const resolved = resolveMimeType(mimeType, fileName);
  if (resolved && BLOCKED_MIMES.has(resolved)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Files of type ${resolved} are not accepted`);
  }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface PutResult {
  storageKey: string;
  localPath?: string;
}

export interface StorageDriver {
  readonly provider: StorageProvider;
  put(key: string, body: Buffer, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Total bytes held, for the admin storage widget. Null when unsupported. */
  usage(): Promise<number | null>;
}

// --- local -----------------------------------------------------------------

class LocalDriver implements StorageDriver {
  readonly provider = 'LOCAL' as const;

  private root(): string {
    return path.resolve(process.cwd(), serverEnv().LOCAL_STORAGE_DIR);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root(), key);
    // Defence against a crafted key escaping the storage root.
    if (!full.startsWith(this.root() + path.sep) && full !== this.root()) {
      throw new AppError('BAD_REQUEST', 'Invalid storage key');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<PutResult> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { storageKey: key, localPath: target };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async usage(): Promise<number | null> {
    try {
      const { readdir } = await import('node:fs/promises');
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else total += (await stat(full)).size;
        }
      };
      await walk(this.root());
      return total;
    } catch {
      return 0;
    }
  }
}

// --- cloudinary ------------------------------------------------------------

class CloudinaryDriver implements StorageDriver {
  readonly provider = 'CLOUDINARY' as const;

  private async sdk() {
    const { v2 } = await import('cloudinary');
    const env = serverEnv();
    v2.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    return v2;
  }

  async put(key: string, body: Buffer): Promise<PutResult> {
    const cloudinary = await this.sdk();
    return new Promise<PutResult>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: key,
          resource_type: 'raw',
          // Private delivery: the browser never gets a Cloudinary URL, only our
          // signed /api/media proxy.
          type: 'authenticated',
          overwrite: true,
        },
        (error, result) => {
          if (error || !result) {
            reject(new AppError('STORAGE_FAILED', 'Upload failed', { cause: error }));
            return;
          }
          resolve({ storageKey: result.public_id });
        },
      );
      stream.end(body);
    });
  }

  async get(key: string): Promise<Buffer> {
    const cloudinary = await this.sdk();
    const url = cloudinary.utils.private_download_url(key, '', {
      resource_type: 'raw',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    const response = await fetch(url);
    if (!response.ok) {
      throw new AppError('STORAGE_FAILED', `Cloudinary read failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const cloudinary = await this.sdk();
    await cloudinary.uploader.destroy(key, { resource_type: 'raw', type: 'authenticated' });
  }

  async usage(): Promise<number | null> {
    try {
      const cloudinary = await this.sdk();
      const result = (await cloudinary.api.usage()) as { storage?: { usage?: number } };
      return result.storage?.usage ?? null;
    } catch {
      return null;
    }
  }
}

// --- s3-compatible ---------------------------------------------------------

interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  /** Sent as `ServerSideEncryption: AES256`; not every S3 clone accepts it. */
  serverSideEncryption: boolean;
}

/** Object counted before `usage()` gives up, to keep the admin view cheap. */
const USAGE_LIST_PAGE_LIMIT = 20;

/**
 * Everything that speaks the S3 API: AWS itself, Backblaze B2, R2, MinIO.
 *
 * The wire protocol is identical, so the subclasses differ only in which
 * credentials they read and which `StorageProvider` they stamp on the rows
 * they create.
 */
abstract class S3CompatibleDriver implements StorageDriver {
  abstract readonly provider: StorageProvider;

  protected abstract config(): S3Config;

  private async client() {
    const mod = await import('@aws-sdk/client-s3').catch(() => null);
    if (!mod) {
      throw new AppError(
        'STORAGE_FAILED',
        `STORAGE_PROVIDER=${serverEnv().STORAGE_PROVIDER} requires @aws-sdk/client-s3. Run: npm i @aws-sdk/client-s3`,
      );
    }
    const config = this.config();
    return {
      mod,
      config,
      client: new mod.S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: Boolean(config.endpoint),
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      }),
      bucket: config.bucket,
    };
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    const { mod, client, bucket, config } = await this.client();
    await client.send(
      new mod.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(config.serverSideEncryption ? { ServerSideEncryption: 'AES256' as const } : {}),
      }),
    );
    return { storageKey: key };
  }

  async get(key: string): Promise<Buffer> {
    const { mod, client, bucket } = await this.client();
    const result = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new AppError('STORAGE_FAILED', 'Empty object');
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    const { mod, client, bucket } = await this.client();
    await client.send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * Sums the bucket by listing it, which is the only portable way to ask.
   *
   * Deliberately bounded: past the page limit the answer would cost more
   * requests than the admin widget is worth, so it reports "unknown" and the
   * view falls back to the figure tracked in the database.
   */
  async usage(): Promise<number | null> {
    try {
      const { mod, client, bucket } = await this.client();
      let total = 0;
      let token: string | undefined;

      for (let page = 0; page < USAGE_LIST_PAGE_LIMIT; page += 1) {
        const result = await client.send(
          new mod.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: 'duo/',
            ContinuationToken: token,
          }),
        );
        for (const object of result.Contents ?? []) total += object.Size ?? 0;
        if (!result.IsTruncated) return total;
        token = result.NextContinuationToken;
      }
      return null;
    } catch (error) {
      log.debug('Bucket usage lookup failed', { error, provider: this.provider });
      return null;
    }
  }
}

class S3Driver extends S3CompatibleDriver {
  readonly provider = 'S3' as const;

  protected config(): S3Config {
    const env = serverEnv();
    return {
      region: env.S3_REGION as string,
      bucket: env.S3_BUCKET as string,
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
      endpoint: env.S3_ENDPOINT,
      serverSideEncryption: true,
    };
  }
}

// --- backblaze b2 ----------------------------------------------------------

class B2Driver extends S3CompatibleDriver {
  readonly provider = 'B2' as const;

  protected config(): S3Config {
    const env = serverEnv();
    return {
      region: env.B2_REGION as string,
      bucket: env.B2_BUCKET as string,
      accessKeyId: env.B2_KEY_ID as string,
      secretAccessKey: env.B2_APPLICATION_KEY as string,
      // B2's endpoint is entirely predictable from the region, so configuring
      // it is optional.
      endpoint: env.B2_ENDPOINT ?? `https://s3.${env.B2_REGION}.backblazeb2.com`,
      // B2 applies its own server-side encryption per bucket and rejects the
      // AWS header outright.
      serverSideEncryption: false,
    };
  }
}

// --- supabase storage ------------------------------------------------------

/**
 * Supabase Storage over its REST API.
 *
 * The `@supabase/supabase-js` client would work too, but it is a large
 * dependency for four HTTP calls, and its upload helper wants a Blob. Plain
 * fetch keeps this driver dependency-free.
 */
/**
 * The largest object Supabase Storage accepts in one request on the free plan.
 * Anything past this is split into parts and stitched back together on read.
 */
const SUPABASE_PART_BYTES = 40 * 1024 * 1024;

/** Attempts for a request that failed for a reason the same bytes may survive. */
const SUPABASE_ATTEMPTS = 3;

/**
 * Supabase reports every failure as a 400 whose body carries the real status,
 * so the HTTP code alone cannot distinguish "too large" from "server broke".
 */
interface SupabaseFailure {
  status: number;
  message: string;
}

async function readSupabaseFailure(response: Response): Promise<SupabaseFailure> {
  const text = await response.text();
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object') {
      const shaped = body as { statusCode?: string; message?: string; error?: string };
      return {
        status: Number(shaped.statusCode ?? response.status),
        message: shaped.message ?? shaped.error ?? text,
      };
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return { status: response.status, message: text };
}

class SupabaseDriver implements StorageDriver {
  readonly provider = 'SUPABASE' as const;

  private base(): string {
    return `${(serverEnv().SUPABASE_URL as string).replace(/\/$/, '')}/storage/v1`;
  }

  private bucket(): string {
    return serverEnv().SUPABASE_STORAGE_BUCKET;
  }

  /** Slashes in a key are real path separators; everything else is escaped. */
  private encode(key: string): string {
    return key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private objectUrl(key: string): string {
    return `${this.base()}/object/${this.bucket()}/${this.encode(key)}`;
  }

  private headers(): Record<string, string> {
    const key = serverEnv().SUPABASE_SERVICE_ROLE_KEY as string;
    return { apikey: key, authorization: `Bearer ${key}` };
  }

  /**
   * A stored key may name one object or several.
   *
   * The part count rides in the key as a `#pN` suffix rather than in a new
   * column, so splitting a large upload needs no migration and no change to
   * anything that merely passes a key around.
   */
  private parts(key: string): string[] {
    const match = /^(.*)#p(\d+)$/.exec(key);
    if (!match?.[1] || !match[2]) return [key];
    const count = Number(match[2]);
    return Array.from({ length: count }, (_, index) => `${match[1]}.p${index}`);
  }

  /** One upload attempt, with retries for failures that are not our fault. */
  private async putOne(key: string, body: Buffer, contentType: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(this.objectUrl(key), {
        method: 'POST',
        headers: {
          ...this.headers(),
          'content-type': contentType,
          // Without this an automatic retry would collide with its own first try.
          'x-upsert': 'true',
        },
        body: new Uint8Array(body),
      });

      if (response.ok) return;

      const failure = await readSupabaseFailure(response);

      // 4xx is the caller's problem — the same bytes fail identically forever,
      // so retrying only delays the error.
      const retryable = failure.status >= 500;
      if (!retryable || attempt >= SUPABASE_ATTEMPTS) {
        throw new AppError(
          'STORAGE_FAILED',
          `Supabase upload failed (${failure.status}): ${failure.message}`,
        );
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<PutResult> {
    if (body.byteLength <= SUPABASE_PART_BYTES) {
      await this.putOne(key, body, contentType);
      return { storageKey: key };
    }

    const total = Math.ceil(body.byteLength / SUPABASE_PART_BYTES);
    const written: string[] = [];

    try {
      for (let index = 0; index < total; index += 1) {
        const partKey = `${key}.p${index}`;
        const start = index * SUPABASE_PART_BYTES;
        await this.putOne(partKey, body.subarray(start, start + SUPABASE_PART_BYTES), contentType);
        written.push(partKey);
      }
    } catch (error) {
      // Never leave half an object behind: an orphaned part is billed storage
      // that nothing will ever read or clean up.
      //
      // Sequential and individually guarded — a cleanup that threw would
      // replace the upload's real error with a misleading one.
      for (const partKey of written) {
        try {
          await fetch(this.objectUrl(partKey), { method: 'DELETE', headers: this.headers() });
        } catch {
          log.warn('Could not remove a partial upload', { partKey });
        }
      }
      throw error;
    }

    return { storageKey: `${key}#p${total}` };
  }

  /**
   * Reads through a short-lived signed URL rather than the object path.
   *
   * The bucket is private, so the object path only answers with the
   * service-role key attached — and that key must never travel further than it
   * has to. A 120-second signature is enough to stream one attachment and
   * useless to anyone who captures it afterwards.
   */
  private async getOne(key: string): Promise<Buffer> {
    const signResponse = await fetch(`${this.base()}/object/sign/${this.bucket()}/${this.encode(key)}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn: 120 }),
    });

    if (!signResponse.ok) {
      const failure = await readSupabaseFailure(signResponse);
      throw new AppError(
        'STORAGE_FAILED',
        `Supabase read failed (${failure.status}): ${failure.message}`,
      );
    }

    const { signedURL } = (await signResponse.json()) as { signedURL: string };

    // Deliberately unauthenticated: the token in the URL is the credential.
    const download = await fetch(`${this.base()}${signedURL}`);
    if (!download.ok) {
      throw new AppError('STORAGE_FAILED', `Supabase download failed (${download.status})`);
    }

    return Buffer.from(await download.arrayBuffer());
  }

  async get(key: string): Promise<Buffer> {
    const parts = this.parts(key);
    if (parts.length === 1 && parts[0]) return this.getOne(parts[0]);

    // Sequential rather than parallel: the parts are 40 MiB each, and holding
    // several in memory at once is what would kill a small container.
    const buffers: Buffer[] = [];
    for (const part of parts) buffers.push(await this.getOne(part));
    return Buffer.concat(buffers);
  }

  async delete(key: string): Promise<void> {
    for (const part of this.parts(key)) {
      const response = await fetch(this.objectUrl(part), {
        method: 'DELETE',
        headers: this.headers(),
      });

      if (response.ok) continue;

      const failure = await readSupabaseFailure(response);
      // A blob that is already gone is the outcome we wanted.
      if (failure.status === 404) continue;

      throw new AppError(
        'STORAGE_FAILED',
        `Supabase delete failed (${failure.status}): ${failure.message}`,
      );
    }
  }

  async usage(): Promise<number | null> {
    // Supabase only lists one prefix at a time and exposes no bucket total, so
    // the database figure is the authoritative one here.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

/**
 * The provider registry.
 *
 * Adding a backend is one entry plus one class; nothing that calls
 * `storageDriver()` ever has to know how many there are.
 */
const DRIVERS: Record<ServerEnv['STORAGE_PROVIDER'], () => StorageDriver> = {
  local: () => new LocalDriver(),
  cloudinary: () => new CloudinaryDriver(),
  s3: () => new S3Driver(),
  supabase: () => new SupabaseDriver(),
  b2: () => new B2Driver(),
};

let driverInstance: StorageDriver | null = null;

export function storageDriver(): StorageDriver {
  if (driverInstance) return driverInstance;
  driverInstance = DRIVERS[serverEnv().STORAGE_PROVIDER]();
  return driverInstance;
}

/**
 * The same registry, addressed by the value stored on the attachment row.
 *
 * `STORAGE_PROVIDER` says where *new* uploads go; `Attachment.provider` says
 * where an existing blob actually is. Switching providers must not strand media
 * already written elsewhere, so every read goes through the row's own provider
 * rather than through the current default.
 */
const DRIVERS_BY_PROVIDER: Record<StorageProvider, () => StorageDriver> = {
  LOCAL: () => new LocalDriver(),
  CLOUDINARY: () => new CloudinaryDriver(),
  S3: () => new S3Driver(),
  SUPABASE: () => new SupabaseDriver(),
  B2: () => new B2Driver(),
};

/** One instance per provider — drivers hold clients and connection pools. */
const driverCache = new Map<StorageProvider, StorageDriver>();

export function storageDriverFor(provider: StorageProvider): StorageDriver {
  const cached = driverCache.get(provider);
  if (cached) return cached;

  const created = DRIVERS_BY_PROVIDER[provider]();
  driverCache.set(provider, created);
  return created;
}

/** Test hook so suites can inject a fake driver. Clearing also drops the cache. */
export function __setStorageDriver(driver: StorageDriver | null): void {
  driverInstance = driver;
  if (!driver) driverCache.clear();
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface StoreInput {
  uploaderId: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  /**
   * Dimensions and duration measured on the client. Preferred over anything the
   * server derives: the recorder knew its own clip, whereas a decoder reading a
   * half-written container often reports nothing at all.
   */
  metadata?: { width?: number; height?: number; duration?: number };
}

export interface StoredAttachment {
  id: string;
  kind: AttachmentKind;
  byteSize: number;
}

function buildKey(uploaderId: string, fileName: string): string {
  const ext = path
    .extname(fileName)
    .slice(0, 12)
    .replace(/[^a-zA-Z0-9.]/g, '');
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `duo/${yyyymm}/${uploaderId.slice(0, 8)}/${randomId(16)}${ext}`;
}

/**
 * Persists bytes and creates the Attachment row.
 *
 * When `MEDIA_ENCRYPTION_KEY` is configured the payload is encrypted with
 * AES-256-GCM *before* it reaches the provider, so the storage vendor holds
 * only opaque ciphertext.
 */
export async function storeAttachment(input: StoreInput): Promise<StoredAttachment> {
  assertMimeAllowed(input.mimeType, input.fileName);

  const maxBytes = serverEnv().MAX_UPLOAD_BYTES;
  if (input.bytes.byteLength > maxBytes) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `Files must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`,
    );
  }

  // A typeless upload is stored under the type its extension implies, not under
  // the empty string the picker supplied.
  const mimeType = resolveMimeType(input.mimeType, input.fileName) || input.mimeType;
  const kind = classifyMime(mimeType, input.fileName);
  const checksum = sha256(input.bytes);
  const driver = storageDriver();
  const key = buildKey(input.uploaderId, input.fileName);

  const { processMedia } = await import('./media-processing');
  const processed = await processMedia({
    bytes: input.bytes,
    mimeType,
    kind,
  });

  const encrypt = mediaEncryptionEnabled();
  const payload = encrypt ? encryptBuffer(processed.bytes) : null;

  const put = await driver.put(
    key,
    payload ? payload.ciphertext : processed.bytes,
    encrypt ? 'application/octet-stream' : mimeType,
  );

  let thumbnailKey: string | null = null;
  let thumbnailIv: string | null = null;
  let thumbnailTag: string | null = null;

  if (processed.thumbnail) {
    thumbnailKey = `${key}.thumb`;
    const thumbPayload = encrypt ? encryptBuffer(processed.thumbnail) : null;
    await driver.put(
      thumbnailKey,
      thumbPayload ? thumbPayload.ciphertext : processed.thumbnail,
      encrypt ? 'application/octet-stream' : 'image/webp',
    );
    thumbnailIv = thumbPayload?.iv ?? null;
    thumbnailTag = thumbPayload?.tag ?? null;
  }

  const attachment = await db.attachment.create({
    data: {
      uploaderId: input.uploaderId,
      kind,
      provider: driver.provider,
      storageKey: put.storageKey,
      localPath: put.localPath ?? null,
      fileName: input.fileName.slice(0, 255),
      mimeType,
      byteSize: processed.bytes.byteLength,
      // The client measured these from the live media; a server-side decoder
      // reading a container the recorder had not finished writing does worse.
      width: input.metadata?.width ?? processed.width,
      height: input.metadata?.height ?? processed.height,
      duration: input.metadata?.duration ?? processed.duration,
      waveform: processed.waveform ?? [],
      blurDataUrl: processed.blurDataUrl,
      thumbnailKey,
      checksum,
      encrypted: encrypt,
      encryptionIv: payload?.iv ?? null,
      encryptionTag: payload?.tag ?? null,
      thumbnailIv,
      thumbnailTag,
    },
    select: { id: true, kind: true, byteSize: true },
  });

  await db.auditLog.create({
    data: {
      userId: input.uploaderId,
      action: 'ATTACHMENT_UPLOADED',
      metadata: { attachmentId: attachment.id, kind, bytes: attachment.byteSize },
    },
  });

  return attachment;
}

export interface LoadedAttachment {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

/** Reads an attachment back, transparently decrypting it. */
export async function loadAttachment(
  attachmentId: string,
  variant?: string,
): Promise<LoadedAttachment> {
  const row = await db.attachment.findUnique({ where: { id: attachmentId } });
  if (!row) throw new AppError('NOT_FOUND', 'Attachment not found');
  if (row.purgedAt) throw new AppError('GONE', 'This media has been destroyed');

  const wantsThumb = variant === 'thumb' && row.thumbnailKey;
  const key = wantsThumb ? (row.thumbnailKey as string) : row.storageKey;

  const driver = storageDriver();
  const raw = await driver.get(key);

  // Each stored object has its own IV/tag pair — the original and its
  // thumbnail are encrypted independently.
  const iv = wantsThumb ? row.thumbnailIv : row.encryptionIv;
  const tag = wantsThumb ? row.thumbnailTag : row.encryptionTag;
  const bytes = row.encrypted && iv && tag ? decryptBuffer(raw, iv, tag) : raw;

  return {
    bytes,
    mimeType: wantsThumb ? 'image/webp' : row.mimeType,
    fileName: row.fileName,
  };
}

/** Irreversibly destroys the blobs behind a message and tombstones the rows. */
export async function purgeAttachmentsForMessage(messageId: string): Promise<number> {
  const attachments = await db.attachment.findMany({
    where: { messageId, purgedAt: null },
    select: { id: true, storageKey: true, thumbnailKey: true },
  });
  if (attachments.length === 0) return 0;

  const driver = storageDriver();

  for (const attachment of attachments) {
    try {
      await driver.delete(attachment.storageKey);
      if (attachment.thumbnailKey) await driver.delete(attachment.thumbnailKey);
    } catch (error) {
      log.error('Failed to delete blob', { error, attachmentId: attachment.id });
    }
  }

  await db.attachment.updateMany({
    where: { id: { in: attachments.map((a) => a.id) } },
    data: {
      purgedAt: new Date(),
      // Scrub the pointers as well as the bytes.
      storageKey: '',
      localPath: null,
      thumbnailKey: null,
      blurDataUrl: null,
      encryptionIv: null,
      encryptionTag: null,
      thumbnailIv: null,
      thumbnailTag: null,
    },
  });

  return attachments.length;
}

/** Removes uploads that were never attached to a message. */
/**
 * What the admin console can wipe.
 *
 * Beyond the attachment kinds there are two pseudo-collections:
 * `MESSAGES` empties the conversation outright, and `ORPHANS` clears uploads
 * that never made it onto a message.
 */
export type PurgeTarget = AttachmentKind | 'MESSAGES' | 'ORPHANS';

export interface PurgeCollectionResult {
  collection: PurgeTarget;
  /** Rows deleted in this batch. */
  attachments: number;
  /** Messages removed because the purge left them with nothing. */
  messages: number;
  /** Rows of this kind still present, so a large collection can be finished off. */
  remaining: number;
}

/**
 * Destroys every attachment of one kind — the admin console's "delete all
 * videos" control.
 *
 * Blobs go first and rows second. The other order would have the database
 * cascade take the keys away while the objects were still in the bucket,
 * leaving bytes that nothing references and nothing will ever clean up.
 *
 * Batched rather than unbounded: a collection of several thousand attachments
 * would otherwise hold one transaction open for minutes. The caller repeats
 * until `remaining` reaches zero.
 */
export async function purgeCollection(
  collection: PurgeTarget,
  batchSize = 200,
): Promise<PurgeCollectionResult> {
  // `MESSAGES` clears every blob first and only then the timeline; `ORPHANS`
  // is scoped to uploads that never reached a message.
  const where =
    collection === 'MESSAGES' ? {}
    : collection === 'ORPHANS' ? { messageId: null }
    : { kind: collection };

  const rows = await db.attachment.findMany({
    where,
    select: { id: true, storageKey: true, thumbnailKey: true, messageId: true },
    take: batchSize,
  });

  if (rows.length === 0) {
    // Emptying the conversation is deferred until the last blob is gone, so an
    // interrupted wipe can never leave messages pointing at deleted media.
    if (collection === 'MESSAGES') {
      const { count } = await db.message.deleteMany({});
      return { collection, attachments: 0, messages: count, remaining: 0 };
    }
    return { collection, attachments: 0, messages: 0, remaining: 0 };
  }

  for (const row of rows) {
    // A blob that will not delete must not stop the rest: the row is going
    // either way, and a failure here is logged rather than fatal.
    await deleteBlob(row.storageKey, row.thumbnailKey);
  }

  const { count: attachments } = await db.attachment.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });

  // A caption outlives its photo. Only a message with nothing left — no
  // attachments and no body — is removed. Skipped for `MESSAGES`, where the
  // whole timeline goes once the blobs are clear.
  const messageIds =
    collection === 'MESSAGES'
      ? []
      : [...new Set(rows.flatMap((row) => (row.messageId ? [row.messageId] : [])))];

  let messages = 0;
  if (messageIds.length > 0) {
    const result = await db.message.deleteMany({
      where: {
        id: { in: messageIds },
        attachments: { none: {} },
        OR: [{ body: null }, { body: '' }],
      },
    });
    messages = result.count;
  }

  const remainingAttachments = await db.attachment.count({ where });
  // For a full wipe the work left is blobs *and* messages, so the caller knows
  // to come back even when every attachment is already gone.
  const remaining =
    collection === 'MESSAGES'
      ? remainingAttachments + (await db.message.count())
      : remainingAttachments;

  log.info('Purged a collection', { collection, attachments, messages, remaining });

  return { collection, attachments, messages, remaining };
}

/** Removes an object and its thumbnail, never throwing. */
async function deleteBlob(storageKey: string, thumbnailKey: string | null): Promise<void> {
  const driver = storageDriver();
  try {
    await driver.delete(storageKey);
    if (thumbnailKey) await driver.delete(thumbnailKey);
  } catch (error) {
    log.warn('Could not delete a blob', { storageKey, error });
  }
}

export async function pruneOrphanAttachments(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
  const orphans = await db.attachment.findMany({
    where: { messageId: null, purgedAt: null, createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true, thumbnailKey: true },
    take: 200,
  });
  if (orphans.length === 0) return 0;

  const driver = storageDriver();
  for (const orphan of orphans) {
    try {
      await driver.delete(orphan.storageKey);
      if (orphan.thumbnailKey) await driver.delete(orphan.thumbnailKey);
    } catch (error) {
      log.warn('Failed to delete orphan blob', { error, attachmentId: orphan.id });
    }
  }

  const { count } = await db.attachment.deleteMany({
    where: { id: { in: orphans.map((o) => o.id) } },
  });
  return count;
}

export interface StorageUsage {
  provider: StorageProvider;
  /** What the database believes is stored, from the attachment rows. */
  trackedBytes: number;
  /** What the driver reports, where it can tell. Null for drivers that cannot. */
  providerBytes: number | null;
  attachmentCount: number;
  /** The configured soft ceiling, for the headroom gauge. */
  quotaBytes: number;
}

/** The admin storage view: totals, a per-kind split, and reclaimable uploads. */
export interface StorageBreakdown {
  usage: StorageUsage;
  byKind: Array<{ kind: string; count: number; bytes: number }>;
  /** Uploads that never made it onto a message and can be pruned. */
  orphaned: number;
}

export async function storageUsage(): Promise<StorageUsage> {
  const driver = storageDriver();
  const [aggregate, providerBytes] = await Promise.all([
    db.attachment.aggregate({
      where: { purgedAt: null },
      _sum: { byteSize: true },
      _count: true,
    }),
    driver.usage(),
  ]);

  return {
    provider: driver.provider,
    trackedBytes: aggregate._sum.byteSize ?? 0,
    providerBytes,
    attachmentCount: aggregate._count,
    quotaBytes: serverEnv().STORAGE_QUOTA_BYTES,
  };
}

/**
 * Loads a freshly stored attachment as the wire model its uploader will see.
 *
 * Signed paths are minted per viewer and per request, so this is the only safe
 * way to hand an attachment back from an upload: the URLs it carries are valid
 * for the caller alone and expire on their own.
 */
export async function loadAttachmentDto(
  attachmentId: string,
  viewerId: string,
): Promise<AttachmentDTO> {
  const row = await db.attachment.findUniqueOrThrow({
    where: { id: attachmentId },
    select: {
      id: true,
      kind: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      width: true,
      height: true,
      duration: true,
      waveform: true,
      blurDataUrl: true,
      thumbnailKey: true,
      purgedAt: true,
    },
  });

  const purged = row.purgedAt !== null;

  return {
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    duration: row.duration,
    waveform: row.waveform,
    blurDataUrl: purged ? null : row.blurDataUrl,
    url: purged
      ? null
      : createSignedMediaPath({ attachmentId: row.id, userId: viewerId, disposition: 'inline' }),
    thumbnailUrl:
      !purged && row.thumbnailKey
        ? createSignedMediaPath({
            attachmentId: row.id,
            userId: viewerId,
            disposition: 'inline',
            variant: 'thumb',
          })
        : null,
    downloadUrl: purged
      ? null
      : createSignedMediaPath({
          attachmentId: row.id,
          userId: viewerId,
          disposition: 'attachment',
        }),
    purged,
  };
}

export { createReadStream };
