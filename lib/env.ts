import { z } from 'zod';

/**
 * Fail-fast validation of the **server** environment.
 *
 * Public variables live in `./env.client`, which this module re-exports for the
 * convenience of server code. Client components must import from `./env.client`
 * directly: importing this module from the browser would ship the entire server
 * schema — every secret's name and validation rule — into the client bundle.
 */

export { type ClientEnv, clientEnv, isDevelopment, isProduction, isTest } from '@/lib/env.client';

const booleanish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/**
 * `.env` files spell "not configured" as `KEY=`, which arrives as an empty
 * string rather than `undefined`. Every optional or defaulted variable is
 * normalised through here, so a commented-out S3 endpoint does not fail URL
 * validation on a deployment that uses local storage.
 */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

function optional<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess(blankToUndefined, schema.optional());
}

function withDefault<T extends z.ZodTypeAny>(
  schema: T,
  fallback: z.input<T>,
): z.ZodEffects<z.ZodDefault<T>> {
  return z.preprocess(blankToUndefined, schema.default(fallback));
}

const serverSchema = z.object({
  NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
  PORT: withDefault(z.coerce.number().int().positive(), 3000),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),

  // --- auth ---
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters of high-entropy random data'),
  BETTER_AUTH_URL: z.string().url(),

  GOOGLE_CLIENT_ID: optional(z.string()),
  GOOGLE_CLIENT_SECRET: optional(z.string()),

  /// The only two email addresses permitted to hold an account.
  AUTHORIZED_USER_1: z.string().email('AUTHORIZED_USER_1 must be a valid email address'),
  AUTHORIZED_USER_2: z.string().email('AUTHORIZED_USER_2 must be a valid email address'),
  /// Which of the two gets the admin dashboard. Defaults to AUTHORIZED_USER_1.
  ADMIN_EMAIL: optional(z.string().email()),

  // --- extra verification ---
  /// A second gate after sign-in: the account holder must also know a phrase.
  ///
  /// Deliberately has no default. A built-in fallback would mean the phrase
  /// lived in the source tree, which is the one place a shared secret must not
  /// be; `serverEnv()` refuses to boot with verification enabled and this unset.
  VERIFICATION_PASSPHRASE: optional(z.string().min(1)),
  VERIFICATION_ENABLED: withDefault(booleanish, 'true'),
  /// How long one successful verification lasts before it is asked for again.
  VERIFICATION_TTL_HOURS: withDefault(z.coerce.number().int().positive(), 12),

  // --- storage ---
  /// Which object store backs uploads. Every provider sits behind the same
  /// driver interface, so switching one out is a deployment change rather than
  /// a code change.
  STORAGE_PROVIDER: withDefault(
    z.enum(['cloudinary', 's3', 'local', 'supabase', 'b2']),
    'local',
  ),

  CLOUDINARY_CLOUD_NAME: optional(z.string()),
  CLOUDINARY_API_KEY: optional(z.string()),
  CLOUDINARY_API_SECRET: optional(z.string()),

  S3_REGION: optional(z.string()),
  S3_BUCKET: optional(z.string()),
  S3_ACCESS_KEY_ID: optional(z.string()),
  S3_SECRET_ACCESS_KEY: optional(z.string()),
  S3_ENDPOINT: optional(z.string().url()),

  /// Supabase Storage. The service-role key is required because uploads bypass
  /// row-level security; it must never be exposed to the browser.
  SUPABASE_URL: optional(z.string().url()),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string()),
  SUPABASE_STORAGE_BUCKET: withDefault(z.string(), 'duo-media'),

  /// Backblaze B2 through its S3-compatible endpoint. `B2_ENDPOINT` is derived
  /// from the region when omitted.
  B2_REGION: optional(z.string()),
  B2_BUCKET: optional(z.string()),
  B2_KEY_ID: optional(z.string()),
  B2_APPLICATION_KEY: optional(z.string()),
  B2_ENDPOINT: optional(z.string().url()),

  LOCAL_STORAGE_DIR: withDefault(z.string(), '.storage'),

  /// Soft ceiling for total stored bytes, surfaced in the admin storage view as
  /// headroom. Nothing enforces it — object stores scale past it happily — but
  /// it gives the usage gauge something to measure against.
  STORAGE_QUOTA_BYTES: withDefault(z.coerce.number().int().positive(), 250 * 1024 * 1024 * 1024),

  /// 32-byte hex key used for AES-256-GCM at-rest encryption of media blobs.
  MEDIA_ENCRYPTION_KEY: optional(
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'MEDIA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  ),
  /// Secret used to sign short-lived media URLs.
  MEDIA_URL_SECRET: z.string().min(32),
  MEDIA_URL_TTL_SECONDS: withDefault(z.coerce.number().int().positive(), 300),
  /// Per-upload ceiling. The upload route buffers each file in memory before it
  /// reaches the driver, so raising this much beyond half a gigabyte needs a
  /// streaming upload path first.
  MAX_UPLOAD_BYTES: withDefault(z.coerce.number().int().positive(), 512 * 1024 * 1024),

  // --- email (password reset) ---
  SMTP_HOST: optional(z.string()),
  SMTP_PORT: optional(z.coerce.number().int().positive()),
  SMTP_USER: optional(z.string()),
  SMTP_PASSWORD: optional(z.string()),
  EMAIL_FROM: optional(z.string()),

  // --- realtime ---
  SOCKET_PATH: withDefault(z.string(), '/api/socket'),
  /// Comma-separated origins permitted to open a socket connection. The
  /// localhost default is a development convenience only — production must name
  /// its real origin, or any site could open a socket against this deployment.
  SOCKET_CORS_ORIGINS: withDefault(z.string(), 'http://localhost:3000'),

  // --- WebRTC ---
  /// Comma-separated STUN URLs. The default pool is deliberately spread across
  /// operators: a single unreachable STUN host otherwise costs every call the
  /// full gathering timeout before it falls back.
  STUN_URLS: withDefault(
    z.string(),
    [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ].join(','),
  ),
  /// Comma-separated TURN URLs. Include a `turns:…:443?transport=tcp` entry to
  /// survive networks that only allow outbound HTTPS.
  TURN_URLS: optional(z.string()),
  TURN_USERNAME: optional(z.string()),
  TURN_CREDENTIAL: optional(z.string()),
  /// coturn `static-auth-secret`. When set, per-session credentials are derived
  /// from it instead of handing the long-lived username/password to the browser.
  TURN_STATIC_AUTH_SECRET: optional(z.string()),
  TURN_CREDENTIAL_TTL_SECONDS: withDefault(z.coerce.number().int().positive(), 3600),
  /// Forces every call through the relay. Useful for diagnosing NAT problems,
  /// and for networks where peer-to-peer is blocked outright.
  TURN_FORCE_RELAY: withDefault(booleanish, 'false'),

  // --- GIF search ---
  /// Omit to hide the GIF picker entirely. Requests are proxied so the key and
  /// the reader's IP address never reach Tenor from the browser.
  TENOR_API_KEY: optional(z.string()),

  // --- behaviour flags ---
  /// When true, purged ephemeral media also has its provider-side object and DB
  /// metadata destroyed rather than merely tombstoned.
  DESTROY_EPHEMERAL_METADATA: withDefault(booleanish, 'true'),
  RATE_LIMIT_ENABLED: withDefault(booleanish, 'true'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/** Variables each storage backend cannot start without. */
const STORAGE_REQUIREMENTS: Record<
  ServerEnv['STORAGE_PROVIDER'],
  readonly (keyof ServerEnv)[]
> = {
  local: [],
  cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  s3: ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
  supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'],
  b2: ['B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'],
};

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

let cachedServerEnv: ServerEnv | null = null;

/**
 * Returns the validated server environment. Throws if called from the browser
 * so that a stray import can never leak secrets into a client bundle.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. Use clientEnv instead.');
  }
  if (cachedServerEnv) return cachedServerEnv;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment variables:\n${formatIssues(parsed.error)}`);
  }

  const env = parsed.data;

  // Cross-field validation that Zod object schemas cannot express alone.
  if (env.AUTHORIZED_USER_1.toLowerCase() === env.AUTHORIZED_USER_2.toLowerCase()) {
    throw new Error('AUTHORIZED_USER_1 and AUTHORIZED_USER_2 must be different email addresses.');
  }

  // One row per storage backend. Adding a provider means adding an entry here
  // and a driver — no other call site needs to know about it.
  const missingFor = STORAGE_REQUIREMENTS[env.STORAGE_PROVIDER].filter((key) => !env[key]);
  if (missingFor.length > 0) {
    throw new Error(`STORAGE_PROVIDER=${env.STORAGE_PROVIDER} requires: ${missingFor.join(', ')}`);
  }

  // Everything below describes a *running deployment*, not a compilation.
  //
  // `next build` evaluates every route module to collect page data, and those
  // modules import this file, so these checks would otherwise run inside the
  // build. A build has no TURN relay, no passphrase and no public origin: the
  // only way to satisfy them there would be to pass runtime secrets as build
  // arguments, which is exactly what the Dockerfile's comments warn against.
  // They therefore stand down for the build and run in full at boot, which is
  // the moment the values are actually needed and actually available.
  if (!isBuildPhase()) {
    // The gate cannot be enforced against a phrase that does not exist, and
    // falling back to a built-in one would defeat the point of having a gate.
    if (env.VERIFICATION_ENABLED && !env.VERIFICATION_PASSPHRASE) {
      throw new Error(
        'VERIFICATION_ENABLED=true requires VERIFICATION_PASSPHRASE.\n' +
          '  • VERIFICATION_PASSPHRASE: non-empty string — the phrase both accounts must type after sign-in\n' +
          '  Set it, or set VERIFICATION_ENABLED=false to disable the second gate entirely.',
      );
    }

    if (env.TURN_FORCE_RELAY && !env.TURN_URLS) {
      throw new Error('TURN_FORCE_RELAY=true requires TURN_URLS, otherwise no call can connect.');
    }

    // Every real relay authenticates. An unauthenticated allocation is refused
    // by the TURN server and the browser reports nothing useful for it, so the
    // symptom is a call that simply never connects. Better to say so at boot.
    const hasTurnAuth =
      Boolean(env.TURN_STATIC_AUTH_SECRET) || Boolean(env.TURN_USERNAME && env.TURN_CREDENTIAL);
    if (env.TURN_URLS && !hasTurnAuth) {
      throw new Error(
        'TURN_URLS is set but no relay credentials are configured. Provide either:\n' +
          '  • TURN_USERNAME + TURN_CREDENTIAL — the long-lived pair your provider issued, or\n' +
          '  • TURN_STATIC_AUTH_SECRET — coturn REST, for credentials minted per session',
      );
    }

    if (env.NODE_ENV === 'production') assertProductionEnv(env);
  }

  cachedServerEnv = env;
  return env;
}

/**
 * Variables whose development fallback is wrong in production.
 *
 * Each entry names the variable and the shape it expects, because the failure
 * these prevent — a socket that accepts any origin, a call that can never
 * connect, an auth URL that loops sign-in back to the login page — is far
 * cheaper to fix at boot than to diagnose in the field.
 */
const PRODUCTION_REQUIREMENTS: ReadonlyArray<{
  name: string;
  format: string;
  missing: (env: ServerEnv) => boolean;
}> = [
  {
    name: 'BETTER_AUTH_URL',
    format: 'https://your-domain — the exact public origin, scheme included, no trailing slash',
    missing: (env) => !isPublicHttpsOrigin(env.BETTER_AUTH_URL),
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    format: 'https://your-domain — must match BETTER_AUTH_URL exactly',
    missing: () => !isPublicHttpsOrigin(process.env['NEXT_PUBLIC_APP_URL']),
  },
  {
    name: 'SOCKET_CORS_ORIGINS',
    format: 'https://your-domain[,https://another-origin] — comma-separated, no wildcard',
    missing: () => !isPublicHttpsOrigin(firstOrigin(process.env['SOCKET_CORS_ORIGINS'])),
  },
  {
    name: 'TURN_URLS',
    format:
      'turn:host:3478[,turns:host:443?transport=tcp] — STUN alone cannot traverse symmetric NAT',
    missing: (env) => !env.TURN_URLS,
  },
];

function firstOrigin(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/** An origin is production-ready when it is HTTPS and not a loopback address. */
function isPublicHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname);
}

/**
 * True while `next build` is compiling.
 *
 * Next sets `NEXT_PHASE` for the build process and its page-data workers
 * inherit it. Build and runtime are separate processes, so the relaxed result
 * is never the one a served request sees.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

function assertProductionEnv(env: ServerEnv): void {
  const failures = PRODUCTION_REQUIREMENTS.filter((requirement) => requirement.missing(env));

  if (failures.length > 0) {
    const lines = failures.map((f) => `  • ${f.name}: ${f.format}`).join('\n');
    throw new Error(
      `Missing or non-production values for ${failures.length} environment ` +
        `variable${failures.length === 1 ? '' : 's'}:\n${lines}`,
    );
  }

  // Not fatal: the app runs correctly without at-rest encryption, it simply
  // stores blobs in the clear, which is a decision rather than a misconfiguration.
  if (!env.MEDIA_ENCRYPTION_KEY) {
    console.warn(
      '[env] MEDIA_ENCRYPTION_KEY is not set — media will be stored unencrypted at rest.',
    );
  }
}

/** Emails allowed to hold an account, normalised to lowercase. */
export function authorizedEmails(): readonly [string, string] {
  const env = serverEnv();
  return [env.AUTHORIZED_USER_1.toLowerCase(), env.AUTHORIZED_USER_2.toLowerCase()] as const;
}

export function adminEmail(): string {
  const env = serverEnv();
  return (env.ADMIN_EMAIL ?? env.AUTHORIZED_USER_1).toLowerCase();
}
