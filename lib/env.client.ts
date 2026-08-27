import { z } from 'zod';

/**
 * Public environment, safe to evaluate in the browser.
 *
 * Kept in its own module so that importing it from a client component does not
 * drag the server schema — every secret's variable name and validation rule —
 * into the browser bundle. The values were never at risk, but the shape of the
 * server configuration is not something a client needs to know.
 *
 * Each variable is read through an explicit literal `process.env.NEXT_PUBLIC_*`
 * access, which is what Next.js's build-time inlining requires.
 */

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

function withDefault<T extends z.ZodTypeAny>(
  schema: T,
  fallback: z.input<T>,
): z.ZodEffects<z.ZodDefault<T>> {
  return z.preprocess(blankToUndefined, schema.default(fallback));
}

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_APP_NAME: withDefault(z.string(), 'Duo'),
  /** Blank for a same-origin socket; set when realtime is deployed separately. */
  NEXT_PUBLIC_SOCKET_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  NEXT_PUBLIC_SOCKET_PATH: withDefault(z.string(), '/api/socket'),
  /** Mirrors the server's MAX_UPLOAD_BYTES so the composer can reject early. */
  NEXT_PUBLIC_MAX_UPLOAD_BYTES: withDefault(z.coerce.number().int().positive(), 512 * 1024 * 1024),
});

export type ClientEnv = z.infer<typeof clientSchema>;

const parsed = clientSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL,
  NEXT_PUBLIC_SOCKET_PATH: process.env.NEXT_PUBLIC_SOCKET_PATH,
  NEXT_PUBLIC_MAX_UPLOAD_BYTES: process.env.NEXT_PUBLIC_MAX_UPLOAD_BYTES,
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid public environment variables:\n${issues}`);
}

export const clientEnv: ClientEnv = parsed.data;

export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = process.env.NODE_ENV === 'development';
export const isTest = process.env.NODE_ENV === 'test';
