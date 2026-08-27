import { clientEnv } from '@/lib/env.client';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const log = createLogger('email');

export interface PasswordResetEmail {
  to: string;
  name: string;
  url: string;
}

/**
 * SMTP is optional.
 *
 * A two-person deployment may reasonably have no mail server at all, and
 * requiring one to boot would be user-hostile. When it is absent the reset link
 * is logged instead — the operator is one of the two users and has the console.
 */
function transportConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.EMAIL_FROM);
}

/**
 * `nodemailer` is imported lazily and only when mail is actually configured.
 *
 * It is a server-only dependency that pulls in a large tree; a static import
 * would put it in the module graph of every route that touches auth, for a
 * feature most deployments never use.
 */
async function send(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const env = serverEnv();
  const { createTransport } = await import('nodemailer');

  const transport = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is implicit TLS; everything else negotiates STARTTLS.
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER && env.SMTP_PASSWORD
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
      : {}),
  });

  await transport.sendMail({ from: env.EMAIL_FROM, ...options });
}

/**
 * Sends the password-reset link.
 *
 * Failures are logged and swallowed. Better Auth calls this from inside the
 * reset request, and letting it throw would tell an unauthenticated caller
 * whether the address exists — the endpoint must answer identically either way.
 */
export async function sendPasswordResetEmail(input: PasswordResetEmail): Promise<void> {
  const appName = clientEnv.NEXT_PUBLIC_APP_NAME;

  if (!transportConfigured()) {
    log.warn('SMTP is not configured — password reset link not emailed', {
      to: input.to,
      url: input.url,
    });
    return;
  }

  const text = [
    `Hi ${input.name},`,
    '',
    `Someone asked to reset the password for your ${appName} account.`,
    'Open the link below to choose a new one. It expires in one hour.',
    '',
    input.url,
    '',
    'If this was not you, ignore this message — nothing has changed.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;line-height:1.6">
      <p>Hi ${escapeHtml(input.name)},</p>
      <p>Someone asked to reset the password for your ${escapeHtml(appName)} account.</p>
      <p>
        <a href="${escapeHtml(input.url)}"
           style="display:inline-block;padding:0.625rem 1.25rem;border-radius:0.5rem;background:#4f46e5;color:#fff;text-decoration:none">
          Choose a new password
        </a>
      </p>
      <p style="color:#666;font-size:0.875rem">This link expires in one hour.</p>
      <p style="color:#666;font-size:0.875rem">
        If this was not you, ignore this message — nothing has changed.
      </p>
    </div>
  `;

  try {
    await send({ to: input.to, subject: `Reset your ${appName} password`, text, html });
    log.info('Password reset email sent', { to: input.to });
  } catch (error) {
    log.error('Could not send the password reset email', { to: input.to, error });
  }
}

/** The name and URL are interpolated into HTML; both are attacker-influenced. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
