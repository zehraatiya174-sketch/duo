import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';

import { db } from '@/lib/db';
import { adminEmail, isProduction, serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { sendPasswordResetEmail } from '@/services/email';

import { isAuthorizedEmail, normalizeEmail } from './allowlist';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password';

const log = createLogger('auth');

const env = serverEnv();

const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/**
 * A sign-in lasts one hour, and one hour only.
 *
 * The same lifetime as the passphrase gate in front of the app, so the two
 * expire together rather than leaving a signed-in tab behind a locked door.
 * `updateAge` matches `expiresIn` deliberately: Better Auth only slides a
 * session forward once `issuedAt + updateAge` has passed, so making them equal
 * means the window can never be extended by activity. An hour from sign-in is
 * an hour, not an hour of idling.
 */
const SESSION_MAX_AGE_SECONDS = 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;

export const auth = betterAuth({
  appName: 'Duo',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: prismaAdapter(db, {
    provider: 'postgresql',
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    // Registration is open only to the two allowlisted addresses; the
    // databaseHooks guard below is what actually enforces it.
    disableSignUp: false,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: PASSWORD_MAX_LENGTH,
    autoSignIn: true,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    password: {
      hash: hashPassword,
      verify: ({ hash, password }) => verifyPassword(hash, password),
    },
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
    onPasswordReset: async ({ user }) => {
      log.info('Password reset completed', { userId: user.id });
    },
  },

  socialProviders: googleEnabled
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID as string,
          clientSecret: env.GOOGLE_CLIENT_SECRET as string,
          // Only ever offer the two allowlisted accounts a chance to link.
          prompt: 'select_account',
        },
      }
    : {},

  session: {
    expiresIn: SESSION_MAX_AGE_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
    cookieCache: {
      // Serves the session from a signed cookie for 5 minutes, which removes a
      // database round trip from the critical path of every navigation.
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  account: {
    accountLinking: {
      // Google and password credentials for the same allowlisted address are
      // the same person by definition here.
      enabled: true,
      trustedProviders: ['google'],
    },
  },

  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
    },
    crossSubDomainCookies: { enabled: false },
  },

  rateLimit: {
    enabled: env.RATE_LIMIT_ENABLED,
    window: 60,
    max: 60,
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * The hard gate. Runs for every account creation path — email signup and
         * OAuth callback alike — before a row is written.
         */
        before: async (user) => {
          const email = normalizeEmail(user.email);

          if (!isAuthorizedEmail(email)) {
            log.warn('Blocked account creation for unauthorized address', { email });
            // Recorded outside the transaction so the rejection is still audited.
            void db.auditLog
              .create({
                data: {
                  action: 'REGISTER_BLOCKED',
                  metadata: { email },
                },
              })
              .catch(() => undefined);

            throw new APIError('FORBIDDEN', {
              code: 'NOT_AUTHORIZED_ACCOUNT',
              message: 'This application is private. Only pre-authorized accounts may sign in.',
            });
          }

          // Belt and braces: never let a third row exist even if the env changes.
          const existing = await db.user.count();
          if (existing >= 2) {
            const alreadyRegistered = await db.user.findUnique({ where: { email } });
            if (!alreadyRegistered) {
              throw new APIError('FORBIDDEN', {
                code: 'NOT_AUTHORIZED_ACCOUNT',
                message: 'This application already has its two accounts.',
              });
            }
          }

          return {
            data: {
              ...user,
              email,
              role: email === adminEmail() ? 'ADMIN' : 'MEMBER',
            },
          };
        },

        /** Provisions the profile, settings and the shared conversation. */
        after: async (user) => {
          const { provisionUser } = await import('@/services/provisioning');
          await provisionUser({
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
          });
        },
      },
    },

    session: {
      create: {
        /** Blocks sign-in for any address that has since left the allowlist. */
        before: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true, banned: true, banExpires: true },
          });

          if (!user || !isAuthorizedEmail(user.email)) {
            throw new APIError('FORBIDDEN', {
              code: 'NOT_AUTHORIZED_ACCOUNT',
              message: 'This account is no longer authorized.',
            });
          }

          if (user.banned && (!user.banExpires || user.banExpires > new Date())) {
            throw new APIError('FORBIDDEN', {
              code: 'ACCOUNT_SUSPENDED',
              message: 'This account is suspended.',
            });
          }

          return { data: session };
        },

        /** Materialises a Device row so the user can audit and revoke logins. */
        after: async (session) => {
          const { recordDeviceForSession } = await import('@/services/devices');
          await recordDeviceForSession(session);
        },
      },
    },
  },

  user: {
    changeEmail: { enabled: false },
    deleteUser: { enabled: false },
  },

  trustedOrigins: [env.BETTER_AUTH_URL, ...env.SOCKET_CORS_ORIGINS.split(',').map((s) => s.trim())],

  // `nextCookies` must be the last plugin so it can flush Set-Cookie headers
  // written by every preceding plugin.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
export type AuthSession = Auth['$Infer']['Session'];
export const isGoogleEnabled = googleEnabled;
