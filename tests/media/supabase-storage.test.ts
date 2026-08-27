// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/lib/errors';

/**
 * The Supabase Storage driver.
 *
 * Two of its behaviours are not obvious from the Supabase documentation and are
 * the reason this suite exists:
 *
 *  1. every failure comes back as HTTP 400 with the status it means buried in
 *     the body, so `response.status` cannot be trusted to decide whether a call
 *     is retryable or whether a delete already got what it wanted; and
 *  2. the project caps a single object at 50 MiB whatever the bucket says, so
 *     anything larger has to be split.
 */

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.SUPABASE_STORAGE_BUCKET = 'Media';

const { storageDriverFor, __setStorageDriver } = await import('@/services/storage');

const BASE = 'https://project.supabase.co/storage/v1';

/**
 * The 400-with-a-body shape Supabase uses for every error it reports.
 *
 * Built per call rather than shared: a `Response` body can only be read once,
 * and a driver that retries reads a fresh one every time.
 */
function supabaseError(status: number, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ statusCode: String(status), error: 'err', message }), {
      status: 400,
    });
}

function signed(path: string): Response {
  return Response.json({ signedURL: `/object/sign/${path}?token=jwt` });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The suite-wide fake driver would otherwise stand in for every provider.
  __setStorageDriver(null);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function driver() {
  return storageDriverFor('SUPABASE');
}

/** The URL a call was made to, so assertions read as the request they describe. */
function urlOf(call: number): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function initOf(call: number): RequestInit {
  return (fetchMock.mock.calls[call]?.[1] ?? {}) as RequestInit;
}

describe('put', () => {
  it('uploads to the configured bucket with the service-role key', async () => {
    fetchMock.mockResolvedValue(Response.json({ Key: 'Media/duo/a.bin' }));

    const result = await driver().put('duo/202608/abc/file.mp4', Buffer.from('hello'), 'video/mp4');

    expect(result).toEqual({ storageKey: 'duo/202608/abc/file.mp4' });
    expect(urlOf(0)).toBe(`${BASE}/object/Media/duo/202608/abc/file.mp4`);

    const init = initOf(0);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(headers.authorization).toBe('Bearer service-role-key');
    expect(headers.apikey).toBe('service-role-key');
    expect(headers['content-type']).toBe('video/mp4');
    // Without upsert an automatic retry would collide with its own first try.
    expect(headers['x-upsert']).toBe('true');
  });

  it('reports what the provider refused rather than a bare status', async () => {
    fetchMock.mockImplementation(supabaseError(413, 'The object exceeded the maximum allowed size'));

    await expect(driver().put('duo/big.bin', Buffer.from('x'), 'video/mp4')).rejects.toThrow(
      /413.*maximum allowed size/,
    );
    // 413 is the caller's problem: the same bytes fail identically every time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a server-side failure, which the same bytes usually survive', async () => {
    fetchMock
      .mockImplementationOnce(supabaseError(500, 'internal'))
      .mockResolvedValueOnce(Response.json({ Key: 'ok' }));

    await expect(driver().put('duo/a.bin', Buffer.from('x'), 'image/webp')).resolves.toEqual({
      storageKey: 'duo/a.bin',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up with a typed error once the retries are spent', async () => {
    fetchMock.mockImplementation(supabaseError(503, 'unavailable'));

    await expect(driver().put('duo/a.bin', Buffer.from('x'), 'image/webp')).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('get', () => {
  it('reads through a short-lived signed URL, never a public path', async () => {
    fetchMock
      .mockResolvedValueOnce(signed('Media/duo/a.bin'))
      .mockResolvedValueOnce(new Response(Buffer.from('payload')));

    await expect(driver().get('duo/a.bin')).resolves.toEqual(Buffer.from('payload'));

    expect(urlOf(0)).toBe(`${BASE}/object/sign/Media/duo/a.bin`);
    expect(JSON.parse(String(initOf(0).body))).toEqual({ expiresIn: 120 });

    // The download carries the token, not the service-role key.
    expect(urlOf(1)).toBe(`${BASE}/object/sign/Media/duo/a.bin?token=jwt`);
    expect(initOf(1).headers).toBeUndefined();
  });

  it('surfaces a missing object rather than an empty buffer', async () => {
    fetchMock.mockImplementation(supabaseError(404, 'Object not found'));

    await expect(driver().get('duo/gone.bin')).rejects.toBeInstanceOf(AppError);
  });
});

describe('delete', () => {
  it('removes the object', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Successfully deleted' }));

    await driver().delete('duo/a.bin');

    expect(initOf(0).method).toBe('DELETE');
    expect(urlOf(0)).toBe(`${BASE}/object/Media/duo/a.bin`);
  });

  it('treats an already-deleted object as done', async () => {
    // Supabase wraps this 404 in a 400, so the body is the only way to see it.
    fetchMock.mockImplementation(supabaseError(404, 'Object not found'));

    await expect(driver().delete('duo/gone.bin')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a refusal', async () => {
    fetchMock.mockImplementation(supabaseError(403, 'new row violates row-level security policy'));

    await expect(driver().delete('duo/a.bin')).rejects.toThrow(/403/);
  });
});

describe('objects larger than the provider accepts', () => {
  /** One byte past a single part, which is the smallest payload that must split. */
  const PART_BYTES = 40 * 1024 * 1024;

  it('splits the upload and records the part count in the key', async () => {
    fetchMock.mockResolvedValue(Response.json({ Key: 'ok' }));
    const body = Buffer.alloc(PART_BYTES + 1, 9);

    const result = await driver().put('duo/big.mp4', body, 'video/mp4');

    // No new column and no migration: the key says how many objects it spans.
    expect(result.storageKey).toBe('duo/big.mp4#p2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toBe(`${BASE}/object/Media/duo/big.mp4.p0`);
    expect(urlOf(1)).toBe(`${BASE}/object/Media/duo/big.mp4.p1`);

    const first = initOf(0).body as Uint8Array;
    const second = initOf(1).body as Uint8Array;
    expect(first.byteLength).toBe(PART_BYTES);
    expect(second.byteLength).toBe(1);
  });

  it('reassembles the parts in order on the way back', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/object/sign/')) {
        return signed(url.slice(`${BASE}/object/sign/`.length));
      }
      return new Response(Buffer.from(url.endsWith('.p0?token=jwt') ? 'first' : 'second'));
    });

    await expect(driver().get('duo/big.mp4#p2')).resolves.toEqual(Buffer.from('firstsecond'));
  });

  it('deletes every part, so nothing is left orphaned in the bucket', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'Successfully deleted' }));

    await driver().delete('duo/big.mp4#p3');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const deleted = fetchMock.mock.calls.map((call) => String(call[0])).sort();
    expect(deleted).toEqual([
      `${BASE}/object/Media/duo/big.mp4.p0`,
      `${BASE}/object/Media/duo/big.mp4.p1`,
      `${BASE}/object/Media/duo/big.mp4.p2`,
    ]);
  });

  it('cleans up the parts it wrote when a later one fails', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ Key: 'ok' }))
      .mockImplementation(supabaseError(413, 'too large'));

    await expect(driver().put('duo/big.mp4', Buffer.alloc(PART_BYTES + 1, 9), 'video/mp4')).rejects.toThrow(
      AppError,
    );

    const deletes = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deletes.map((call) => String(call[0]))).toEqual([
      `${BASE}/object/Media/duo/big.mp4.p0`,
    ]);
  });
});

describe('driver routing', () => {
  it('reads an attachment from the backend it was written to', () => {
    // Switching STORAGE_PROVIDER must not strand media already stored
    // elsewhere, so the row's own provider decides.
    expect(storageDriverFor('SUPABASE').provider).toBe('SUPABASE');
    expect(storageDriverFor('CLOUDINARY').provider).toBe('CLOUDINARY');
    expect(storageDriverFor('LOCAL').provider).toBe('LOCAL');
  });

  it('reuses one instance per provider', () => {
    expect(storageDriverFor('SUPABASE')).toBe(storageDriverFor('SUPABASE'));
  });
});
