// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';

import { createPrismaMock, resetPrismaMock } from '../helpers/prisma-mock';
import { ALICE } from '../helpers/factories';

const prisma = createPrismaMock();
vi.mock('@/lib/db', () => ({ db: prisma }));

const {
  __setStorageDriver,
  assertMimeAllowed,
  classifyMime,
  loadAttachment,
  loadAttachmentDto,
  pruneOrphanAttachments,
  purgeAttachmentsForMessage,
  purgeCollection,
  resolveMimeType,
  storeAttachment,
  storageUsage,
} = await import('@/services/storage');
const { decryptBuffer } = await import('@/lib/crypto');

type Blob = { body: Buffer; contentType: string };

/** An in-memory driver, so the suite never touches the filesystem. */
function fakeDriver() {
  const objects = new Map<string, Blob>();
  const deleted: string[] = [];

  return {
    objects,
    deleted,
    driver: {
      provider: 'LOCAL' as const,
      put: vi.fn(async (key: string, body: Buffer, contentType: string) => {
        objects.set(key, { body, contentType });
        return { storageKey: key, localPath: `/tmp/${key}` };
      }),
      get: vi.fn(async (key: string) => {
        const blob = objects.get(key);
        if (!blob) throw new Error(`missing object: ${key}`);
        return blob.body;
      }),
      delete: vi.fn(async (key: string) => {
        deleted.push(key);
        objects.delete(key);
      }),
      usage: vi.fn(async () => 4096),
    },
  };
}

let fake: ReturnType<typeof fakeDriver>;

beforeEach(() => {
  resetPrismaMock(prisma);
  fake = fakeDriver();
  __setStorageDriver(fake.driver);
});

afterEach(() => {
  __setStorageDriver(null);
});

describe('classifyMime', () => {
  it('routes by MIME type first', () => {
    expect(classifyMime('image/png', 'a.png')).toBe('IMAGE');
    expect(classifyMime('image/gif', 'a.gif')).toBe('GIF');
    expect(classifyMime('video/mp4', 'a.mp4')).toBe('VIDEO');
    expect(classifyMime('audio/webm', 'a.webm')).toBe('AUDIO');
    expect(classifyMime('application/pdf', 'a.pdf')).toBe('DOCUMENT');
    expect(classifyMime('application/zip', 'a.zip')).toBe('ARCHIVE');
  });

  it('recognises the Office formats the spec names', () => {
    expect(
      classifyMime(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'report.docx',
      ),
    ).toBe('DOCUMENT');
    expect(
      classifyMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'),
    ).toBe('DOCUMENT');
    expect(
      classifyMime(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'a.pptx',
      ),
    ).toBe('DOCUMENT');
  });

  it('is case-insensitive about the MIME type', () => {
    expect(classifyMime('IMAGE/PNG', 'a.png')).toBe('IMAGE');
  });

  it('falls back to the extension when the browser sends a useless type', () => {
    expect(classifyMime('application/octet-stream', 'archive.7z')).toBe('ARCHIVE');
    expect(classifyMime('application/octet-stream', 'slides.pptx')).toBe('DOCUMENT');
    expect(classifyMime('application/octet-stream', 'mystery.bin')).toBe('OTHER');
  });

  /**
   * Windows reports no type at all for a container it has no codec for, and
   * several Android pickers report octet-stream. Filed as a document, such a
   * video would render as a paperclip and download instead of playing.
   */
  it('recognises a video container the picker could not name', () => {
    for (const [type, name] of [
      ['', 'holiday.mkv'],
      ['application/octet-stream', 'holiday.avi'],
      ['', 'clip.mov'],
      ['application/octet-stream', 'phone.3gp'],
      ['', 'stream.m2ts'],
    ] as const) {
      expect(classifyMime(type, name), name).toBe('VIDEO');
    }
  });

  it('recognises typeless audio and images too', () => {
    expect(classifyMime('', 'song.flac')).toBe('AUDIO');
    expect(classifyMime('application/octet-stream', 'photo.heic')).toBe('IMAGE');
    expect(classifyMime('', 'sticker.gif')).toBe('GIF');
  });
});

describe('resolveMimeType', () => {
  it('keeps a type the browser was sure about', () => {
    expect(resolveMimeType('video/mp4', 'clip.mkv')).toBe('video/mp4');
  });

  /** `<video>` will not play a source it cannot name, whatever the bytes are. */
  it('names a container the browser could not', () => {
    expect(resolveMimeType('', 'holiday.mkv')).toBe('video/x-matroska');
    expect(resolveMimeType('application/octet-stream', 'holiday.avi')).toBe('video/x-msvideo');
  });

  it('leaves a genuinely unknown file as a byte stream', () => {
    expect(resolveMimeType('', 'mystery.bin')).toBe('application/octet-stream');
  });
});

describe('assertMimeAllowed', () => {
  it('rejects the script execution vectors', () => {
    for (const mime of [
      'image/svg+xml',
      'text/html',
      'application/x-msdownload',
      'application/x-sh',
    ]) {
      expect(() => assertMimeAllowed(mime), mime).toThrow(AppError);
    }
  });

  it('rejects them however they are capitalised', () => {
    expect(() => assertMimeAllowed('Image/SVG+XML')).toThrow(/not accepted/);
  });

  it('answers with 415, not a generic failure', () => {
    try {
      assertMimeAllowed('text/html');
      expect.unreachable('text/html must be refused');
    } catch (error) {
      expect(error).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
  });

  /** Otherwise a typeless upload smuggles a blocked type past the check. */
  it('refuses an executable or markup extension however it is typed', () => {
    for (const name of ['payload.svg', 'page.html', 'setup.exe', 'run.sh', 'macro.ps1']) {
      expect(() => assertMimeAllowed('application/octet-stream', name), name).toThrow(AppError);
    }
  });

  it('permits ordinary media', () => {
    for (const mime of ['image/png', 'image/webp', 'video/mp4', 'application/pdf']) {
      expect(() => assertMimeAllowed(mime), mime).not.toThrow();
    }
    expect(() => assertMimeAllowed('', 'holiday.mkv')).not.toThrow();
  });
});

describe('storeAttachment', () => {
  const pdf = () => ({
    uploaderId: ALICE,
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7 pretend document body'),
  });

  beforeEach(() => {
    prisma.attachment.create.mockResolvedValue({ id: 'att_1', kind: 'DOCUMENT', byteSize: 30 });
    prisma.auditLog.create.mockResolvedValue({ id: 'aud_1' });
  });

  it('hands the provider ciphertext, never the original bytes', async () => {
    const input = pdf();
    await storeAttachment(input);

    const [stored] = [...fake.objects.values()];
    expect(stored).toBeDefined();
    expect(stored?.body.equals(input.bytes)).toBe(false);
    expect(stored?.contentType).toBe('application/octet-stream');
  });

  it('records the IV and tag needed to read it back', async () => {
    await storeAttachment(pdf());

    const data = prisma.attachment.create.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ encrypted: true, provider: 'LOCAL' });
    expect(data.encryptionIv).toMatch(/^[0-9a-f]{24}$/);
    expect(data.encryptionTag).toMatch(/^[0-9a-f]{32}$/);
  });

  it('stores bytes that decrypt back to the original', async () => {
    const input = pdf();
    await storeAttachment(input);

    const data = prisma.attachment.create.mock.calls[0]?.[0]?.data;
    const [stored] = [...fake.objects.values()];
    const plaintext = decryptBuffer(
      stored?.body ?? Buffer.alloc(0),
      data.encryptionIv,
      data.encryptionTag,
    );

    expect(plaintext.equals(input.bytes)).toBe(true);
  });

  it('namespaces the key by month and uploader, and keeps the extension', async () => {
    await storeAttachment(pdf());

    const [key] = [...fake.objects.keys()];
    expect(key).toMatch(/^duo\/\d{6}\/usr_alic\/[A-Za-z0-9_-]+\.pdf$/);
  });

  it('never lets a crafted filename shape the storage key', async () => {
    await storeAttachment({ ...pdf(), fileName: '../../etc/passwd.pdf' });

    const [key] = [...fake.objects.keys()];
    expect(key).not.toContain('..');
    expect(key?.split('/')).toHaveLength(4);
  });

  it('truncates an absurdly long filename to what the column holds', async () => {
    await storeAttachment({ ...pdf(), fileName: `${'a'.repeat(400)}.pdf` });

    const data = prisma.attachment.create.mock.calls[0]?.[0]?.data;
    expect(data.fileName).toHaveLength(255);
  });

  it('refuses a blocked type before writing anything', async () => {
    await expect(
      storeAttachment({ ...pdf(), fileName: 'x.svg', mimeType: 'image/svg+xml' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });

    expect(fake.driver.put).not.toHaveBeenCalled();
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('refuses an upload past MAX_UPLOAD_BYTES with 413, before hashing or writing it', async () => {
    // Allocating a real half-gigabyte buffer would cost the suite half a
    // gigabyte; the size check reads byteLength and nothing else.
    const oversized = Object.defineProperty(Buffer.alloc(0), 'byteLength', {
      value: 512 * 1024 * 1024 + 1,
    });

    await expect(storeAttachment({ ...pdf(), bytes: oversized })).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });

    expect(fake.driver.put).not.toHaveBeenCalled();
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });

  /**
   * The server has no ffmpeg, so a video's dimensions and running time only
   * exist because the sender's decoder measured them.
   */
  it('keeps the metadata the client measured for a video', async () => {
    prisma.attachment.create.mockResolvedValue({ id: 'att_2', kind: 'VIDEO', byteSize: 12 });

    await storeAttachment({
      uploaderId: ALICE,
      fileName: 'holiday.mkv',
      // The picker had no idea what this was; the extension decides.
      mimeType: '',
      bytes: Buffer.from('pretend video'),
      metadata: { width: 1920, height: 1080, duration: 42 },
    });

    expect(prisma.attachment.create.mock.calls[0]?.[0]?.data).toMatchObject({
      kind: 'VIDEO',
      mimeType: 'video/x-matroska',
      width: 1920,
      height: 1080,
      duration: 42,
    });
  });

  it('writes an audit log entry for every upload', async () => {
    await storeAttachment(pdf());

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: ALICE, action: 'ATTACHMENT_UPLOADED' }),
      }),
    );
  });
});

describe('loadAttachment', () => {
  it('decrypts on the way out', async () => {
    const plaintext = Buffer.from('the original bytes');
    prisma.attachment.create.mockResolvedValue({ id: 'att_1', kind: 'DOCUMENT', byteSize: 18 });
    prisma.auditLog.create.mockResolvedValue({ id: 'aud_1' });

    await storeAttachment({
      uploaderId: ALICE,
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      bytes: plaintext,
    });
    const data = prisma.attachment.create.mock.calls[0]?.[0]?.data;
    prisma.attachment.findUnique.mockResolvedValue({
      ...data,
      id: 'att_1',
      purgedAt: null,
      thumbnailKey: null,
    });

    const loaded = await loadAttachment('att_1');
    expect(loaded.bytes.equals(plaintext)).toBe(true);
    expect(loaded.mimeType).toBe('application/pdf');
  });

  it('is 404 for an unknown attachment', async () => {
    prisma.attachment.findUnique.mockResolvedValue(null);
    await expect(loadAttachment('att_missing')).rejects.toMatchObject({ status: 404 });
  });

  /** The other half of "delete permanently": purged media reads as gone. */
  it('is 410 Gone for purged media, and never touches the provider', async () => {
    prisma.attachment.findUnique.mockResolvedValue({
      id: 'att_1',
      purgedAt: new Date(),
      storageKey: '',
      encrypted: true,
      encryptionIv: null,
      encryptionTag: null,
      thumbnailKey: null,
      mimeType: 'image/webp',
      fileName: 'a.webp',
    });

    await expect(loadAttachment('att_1')).rejects.toMatchObject({ status: 410, code: 'GONE' });
    expect(fake.driver.get).not.toHaveBeenCalled();
  });

  it('serves the thumbnail with its own key and its own IV', async () => {
    fake.objects.set('key.thumb', { body: Buffer.from('thumb-bytes'), contentType: 'image/webp' });
    prisma.attachment.findUnique.mockResolvedValue({
      id: 'att_1',
      purgedAt: null,
      storageKey: 'key',
      thumbnailKey: 'key.thumb',
      encrypted: false,
      encryptionIv: null,
      encryptionTag: null,
      thumbnailIv: null,
      thumbnailTag: null,
      mimeType: 'image/png',
      fileName: 'a.png',
    });

    const loaded = await loadAttachment('att_1', 'thumb');
    expect(fake.driver.get).toHaveBeenCalledWith('key.thumb');
    expect(loaded.mimeType).toBe('image/webp');
  });

  it('falls back to the original when no thumbnail exists', async () => {
    fake.objects.set('key', { body: Buffer.from('full-bytes'), contentType: 'image/png' });
    prisma.attachment.findUnique.mockResolvedValue({
      id: 'att_1',
      purgedAt: null,
      storageKey: 'key',
      thumbnailKey: null,
      encrypted: false,
      encryptionIv: null,
      encryptionTag: null,
      mimeType: 'image/png',
      fileName: 'a.png',
    });

    await loadAttachment('att_1', 'thumb');
    expect(fake.driver.get).toHaveBeenCalledWith('key');
  });
});

describe('purgeAttachmentsForMessage', () => {
  it('deletes the blob, the thumbnail, and scrubs every pointer', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: 'key-1.thumb' },
    ]);
    prisma.attachment.updateMany.mockResolvedValue({ count: 1 });

    const purged = await purgeAttachmentsForMessage('msg_1');

    expect(purged).toBe(1);
    expect(fake.deleted).toEqual(['key-1', 'key-1.thumb']);

    const update = prisma.attachment.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({
      storageKey: '',
      localPath: null,
      thumbnailKey: null,
      blurDataUrl: null,
      encryptionIv: null,
      encryptionTag: null,
      thumbnailIv: null,
      thumbnailTag: null,
    });
    expect(update.data.purgedAt).toBeInstanceOf(Date);
  });

  it('is a no-op when there is nothing left to purge', async () => {
    prisma.attachment.findMany.mockResolvedValue([]);

    expect(await purgeAttachmentsForMessage('msg_1')).toBe(0);
    expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
  });

  /** A provider outage must not leave the row pointing at live bytes. */
  it('still tombstones the rows when the provider delete fails', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
    ]);
    prisma.attachment.updateMany.mockResolvedValue({ count: 1 });
    fake.driver.delete.mockRejectedValueOnce(new Error('provider down'));

    await expect(purgeAttachmentsForMessage('msg_1')).resolves.toBe(1);
    expect(prisma.attachment.updateMany).toHaveBeenCalled();
  });
});

describe('pruneOrphanAttachments', () => {
  it('deletes uploads that never made it onto a message', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
      { id: 'att_2', storageKey: 'key-2', thumbnailKey: 'key-2.thumb' },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 2 });

    expect(await pruneOrphanAttachments()).toBe(2);
    expect(fake.deleted).toEqual(['key-1', 'key-2', 'key-2.thumb']);
  });

  it('only considers unattached rows older than the cutoff', async () => {
    prisma.attachment.findMany.mockResolvedValue([]);
    await pruneOrphanAttachments(6);

    const where = prisma.attachment.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ messageId: null, purgedAt: null });
    expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 6 * 3600_000);
  });

  it('does nothing when there are no orphans', async () => {
    prisma.attachment.findMany.mockResolvedValue([]);

    expect(await pruneOrphanAttachments()).toBe(0);
    expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
  });
});

describe('purgeCollection', () => {
  it('destroys the blobs of one kind and drops the rows', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'vid-1', thumbnailKey: 'vid-1.thumb', messageId: 'msg_1' },
      { id: 'att_2', storageKey: 'vid-2', thumbnailKey: null, messageId: 'msg_2' },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 2 });
    prisma.message.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    await expect(purgeCollection('VIDEO')).resolves.toEqual({
      collection: 'VIDEO',
      attachments: 2,
      messages: 1,
      remaining: 0,
    });

    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'VIDEO' } }),
    );
    // Thumbnails go with their originals, or the store keeps the preview of a
    // video that no longer exists.
    expect(fake.deleted).toEqual(['vid-1', 'vid-1.thumb', 'vid-2']);
  });

  it('only removes the messages those attachments left empty', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'img-1', thumbnailKey: null, messageId: 'msg_1' },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.message.deleteMany.mockResolvedValue({ count: 0 });
    prisma.attachment.count.mockResolvedValue(0);

    await purgeCollection('IMAGE');

    // A caption survives its photo: the row is only deleted when nothing is
    // left of it.
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['msg_1'] },
        attachments: { none: {} },
        OR: [{ body: null }, { body: '' }],
      },
    });
  });

  it('reports what is left so a large collection can be finished off', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'aud-1', thumbnailKey: null, messageId: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(742);

    await expect(purgeCollection('VOICE_NOTE')).resolves.toMatchObject({ remaining: 742 });
    // Nothing to empty: the row was never on a message.
    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
  });

  it('takes the bytes out of the store before the cascade can orphan them', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    // Still blobs left, so the timeline is left alone this pass.
    prisma.attachment.count.mockResolvedValue(9);
    prisma.message.count.mockResolvedValue(30);

    await expect(purgeCollection('MESSAGES')).resolves.toEqual({
      collection: 'MESSAGES',
      attachments: 1,
      messages: 0,
      remaining: 39,
    });
    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
  });

  it('empties the conversation once no blobs are left', async () => {
    prisma.attachment.findMany.mockResolvedValue([]);
    prisma.attachment.count.mockResolvedValue(0);
    prisma.message.deleteMany.mockResolvedValue({ count: 128 });

    await expect(purgeCollection('MESSAGES')).resolves.toEqual({
      collection: 'MESSAGES',
      attachments: 0,
      messages: 128,
      remaining: 0,
    });
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({});
  });

  it('routes ORPHANS through the existing prune', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    await expect(purgeCollection('ORPHANS')).resolves.toEqual({
      collection: 'ORPHANS',
      attachments: 1,
      messages: 0,
      remaining: 0,
    });
  });

  it('drops the row even when the blob cannot be reached', async () => {
    fake.driver.delete.mockRejectedValueOnce(new Error('provider down'));
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'gone', thumbnailKey: null, messageId: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    // Otherwise one unreachable object stalls the whole collection forever.
    await expect(purgeCollection('DOCUMENT')).resolves.toMatchObject({ attachments: 1 });
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['att_1'] } } });
  });
});

describe('purgeCollection', () => {
  it('destroys the blobs of one kind and drops the rows', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'vid-1', thumbnailKey: 'vid-1.thumb', messageId: 'msg_1' },
      { id: 'att_2', storageKey: 'vid-2', thumbnailKey: null, messageId: 'msg_2' },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 2 });
    prisma.message.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    await expect(purgeCollection('VIDEO')).resolves.toEqual({
      collection: 'VIDEO',
      attachments: 2,
      messages: 1,
      remaining: 0,
    });

    expect(prisma.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'VIDEO' } }),
    );
    // Thumbnails go with their originals, or the store keeps the preview of a
    // video that no longer exists.
    expect(fake.deleted).toEqual(['vid-1', 'vid-1.thumb', 'vid-2']);
  });

  it('only removes the messages those attachments left empty', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'img-1', thumbnailKey: null, messageId: 'msg_1' },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.message.deleteMany.mockResolvedValue({ count: 0 });
    prisma.attachment.count.mockResolvedValue(0);

    await purgeCollection('IMAGE');

    // A caption survives its photo: the row is only deleted when nothing is
    // left of it.
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['msg_1'] },
        attachments: { none: {} },
        OR: [{ body: null }, { body: '' }],
      },
    });
  });

  it('reports what is left so a large collection can be finished off', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'aud-1', thumbnailKey: null, messageId: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(742);

    await expect(purgeCollection('VOICE_NOTE')).resolves.toMatchObject({ remaining: 742 });
    // Nothing to empty: the row was never on a message.
    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
  });

  it('takes the bytes out of the store before the cascade can orphan them', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    // Still blobs left, so the timeline is left alone this pass.
    prisma.attachment.count.mockResolvedValue(9);
    prisma.message.count.mockResolvedValue(30);

    await expect(purgeCollection('MESSAGES')).resolves.toEqual({
      collection: 'MESSAGES',
      attachments: 1,
      messages: 0,
      remaining: 39,
    });
    expect(prisma.message.deleteMany).not.toHaveBeenCalled();
  });

  it('empties the conversation once no blobs are left', async () => {
    prisma.attachment.findMany.mockResolvedValue([]);
    prisma.attachment.count.mockResolvedValue(0);
    prisma.message.deleteMany.mockResolvedValue({ count: 128 });

    await expect(purgeCollection('MESSAGES')).resolves.toEqual({
      collection: 'MESSAGES',
      attachments: 0,
      messages: 128,
      remaining: 0,
    });
    expect(prisma.message.deleteMany).toHaveBeenCalledWith({});
  });

  it('routes ORPHANS through the existing prune', async () => {
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'key-1', thumbnailKey: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    await expect(purgeCollection('ORPHANS')).resolves.toEqual({
      collection: 'ORPHANS',
      attachments: 1,
      messages: 0,
      remaining: 0,
    });
  });

  it('drops the row even when the blob cannot be reached', async () => {
    fake.driver.delete.mockRejectedValueOnce(new Error('provider down'));
    prisma.attachment.findMany.mockResolvedValue([
      { id: 'att_1', storageKey: 'gone', thumbnailKey: null, messageId: null },
    ]);
    prisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.attachment.count.mockResolvedValue(0);

    // Otherwise one unreachable object stalls the whole collection forever.
    await expect(purgeCollection('DOCUMENT')).resolves.toMatchObject({ attachments: 1 });
    expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['att_1'] } } });
  });
});

describe('storageUsage', () => {
  it('reports the tracked total alongside what the provider says', async () => {
    prisma.attachment.aggregate.mockResolvedValue({ _sum: { byteSize: 3000 }, _count: 2 });

    await expect(storageUsage()).resolves.toEqual({
      provider: 'LOCAL',
      trackedBytes: 3000,
      providerBytes: 4096,
      attachmentCount: 2,
      quotaBytes: 250 * 1024 * 1024 * 1024,
    });
  });

  it('reads an empty store as zero rather than null', async () => {
    prisma.attachment.aggregate.mockResolvedValue({ _sum: { byteSize: null }, _count: 0 });
    await expect(storageUsage()).resolves.toMatchObject({ trackedBytes: 0 });
  });
});

describe('loadAttachmentDto', () => {
  const row = {
    id: 'att_1',
    kind: 'IMAGE',
    fileName: 'photo.webp',
    mimeType: 'image/webp',
    byteSize: 2048,
    width: 100,
    height: 100,
    duration: null,
    waveform: [],
    blurDataUrl: 'data:image/webp;base64,AAAA',
    thumbnailKey: 'key.thumb',
    purgedAt: null,
  };

  it('mints URLs bound to the requesting viewer', async () => {
    prisma.attachment.findUniqueOrThrow.mockResolvedValue(row);

    const forAlice = await loadAttachmentDto('att_1', 'usr_alice');
    const forBob = await loadAttachmentDto('att_1', 'usr_bob');

    expect(forAlice.url).toContain('/api/media/att_1');
    expect(forAlice.thumbnailUrl).toContain('v=thumb');
    expect(forAlice.downloadUrl).toContain('d=attachment');
    expect(forAlice.url).not.toBe(forBob.url);
  });

  it('withholds everything for a purged attachment', async () => {
    prisma.attachment.findUniqueOrThrow.mockResolvedValue({ ...row, purgedAt: new Date() });

    const dto = await loadAttachmentDto('att_1', 'usr_alice');
    expect(dto).toMatchObject({
      purged: true,
      url: null,
      thumbnailUrl: null,
      downloadUrl: null,
      blurDataUrl: null,
    });
  });
});
