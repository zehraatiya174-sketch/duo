/**
 * Live check of the Supabase driver against the real bucket.
 *
 * Temporary: run once during the provider switch, then deleted. Every object it
 * writes lives under `duo/__verify__/` and is removed before it exits.
 */
import { randomBytes } from 'node:crypto';

import { decryptBuffer, encryptBuffer, mediaEncryptionEnabled } from '@/lib/crypto';
import { serverEnv } from '@/lib/env';
import { storageDriverFor } from '@/services/storage';

const driver = storageDriverFor('SUPABASE');
const prefix = `duo/__verify__/${Date.now()}`;
const written: string[] = [];

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function roundTrip(label: string, size: number): Promise<void> {
  const plaintext = randomBytes(size);
  const { ciphertext, iv, tag } = encryptBuffer(plaintext);

  const started = Date.now();
  const put = await driver.put(`${prefix}/${label}.bin`, ciphertext, 'application/octet-stream');
  written.push(put.storageKey);

  const raw = await driver.get(put.storageKey);
  const decrypted = decryptBuffer(raw, iv, tag);

  check(
    `${label}: ${(size / 1024 / 1024).toFixed(1)} MB round trip`,
    decrypted.equals(plaintext),
    `key=${put.storageKey} ${Date.now() - started}ms`,
  );
}

async function main(): Promise<void> {
  const env = serverEnv();
  console.log(`provider=${env.STORAGE_PROVIDER} bucket=${JSON.stringify(env.SUPABASE_STORAGE_BUCKET)}`);
  check('media encryption is on', mediaEncryptionEnabled());

  // A photo, a voice note, and a video past the 50 MiB per-object ceiling.
  await roundTrip('image', 512 * 1024);
  await roundTrip('voice', 96 * 1024);
  await roundTrip('video', 92 * 1024 * 1024);

  // The thumbnail is a second object beside the original, as storeAttachment writes it.
  const thumb = await driver.put(`${prefix}/image.bin.thumb`, Buffer.from('webp-bytes'), 'application/octet-stream');
  written.push(thumb.storageKey);
  check('thumbnail object', (await driver.get(thumb.storageKey)).toString() === 'webp-bytes');

  // The bucket must refuse an unauthenticated read: signed URLs are the only way in.
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${env.SUPABASE_STORAGE_BUCKET}/${prefix}/image.bin`;
  const anonymous = await fetch(publicUrl);
  check('bucket is private', !anonymous.ok, `anonymous read → ${anonymous.status}`);

  // Deleting is what view-once, view-twice and disappearing media all end in.
  for (const key of written) await driver.delete(key);
  const gone = await driver
    .get(written[0] as string)
    .then(() => false)
    .catch(() => true);
  check('purged media is unreadable', gone);

  // A purge that runs twice must not fail the second time.
  await driver.delete(`${prefix}/never-existed.bin`);
  check('deleting a missing object is a no-op', true);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
