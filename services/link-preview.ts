import { parse } from 'node-html-parser';

import { createLogger } from '@/lib/logger';

const log = createLogger('link-preview');

/** Matches the nullable columns on `LinkPreview`, minus the relation. */
export interface LinkPreviewData {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

/** A slow remote server must not hold a socket handler open. */
const TIMEOUT_MS = 5_000;

/** Enough for any plausible `<head>`; a 200 MB video would otherwise be read. */
const MAX_BYTES = 512 * 1024;

/**
 * Blocks server-side request forgery.
 *
 * This function fetches a URL chosen by whoever sent the message, from inside
 * the server's own network. Without this check a message containing
 * `http://169.254.169.254/…` would make the app read its own cloud metadata —
 * including credentials — and store the result in a preview card.
 *
 * DNS is not resolved here, so a hostname that resolves to a private address
 * still gets through; the remaining defence is that only the parsed title,
 * description and image URL are ever persisted, never the raw body.
 */
function isPubliclyRoutable(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return false;
  }

  // IPv6 loopback and unique-local.
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    // Link-local, which is where cloud metadata services live.
    if (a === 169 && b === 254) return false;
  }

  return true;
}

function absolute(value: string | undefined, base: URL): string | null {
  if (!value) return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function clamp(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Reads Open Graph metadata from a URL found in a message.
 *
 * Best-effort throughout: any failure returns null and the message simply
 * renders without a card. Only the `<head>` is needed, so the body is read
 * incrementally and abandoned once `</head>` is seen or the cap is hit.
 */
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewData | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!isPubliclyRoutable(url)) {
    log.warn('Refused to preview a non-public address', { url: rawUrl });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some sites serve no OG tags without a browser-shaped Accept header.
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'DuoBot/1.0 (+link-preview)',
      },
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) return null;

    const html = await readCapped(response, MAX_BYTES);
    const root = parse(html);

    const meta = (property: string): string | undefined =>
      root.querySelector(`meta[property="${property}"]`)?.getAttribute('content') ??
      root.querySelector(`meta[name="${property}"]`)?.getAttribute('content');

    const final = new URL(response.url || url.toString());

    const title = clamp(meta('og:title') ?? root.querySelector('title')?.text, 300);
    const description = clamp(meta('og:description') ?? meta('description'), 600);

    // A card with neither a title nor a description is just a bare link.
    if (!title && !description) return null;

    return {
      url: rawUrl,
      canonicalUrl: absolute(
        root.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? meta('og:url'),
        final,
      ),
      title,
      description,
      imageUrl: absolute(meta('og:image') ?? meta('twitter:image'), final),
      siteName: clamp(meta('og:site_name'), 80) ?? final.hostname,
      faviconUrl: absolute(
        root.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? '/favicon.ico',
        final,
      ),
    };
  } catch (error) {
    log.debug('Link preview fetch failed', { url: rawUrl, error });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the body up to `limit` bytes, stopping early once `</head>` appears. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      html += decoder.decode(value, { stream: true });

      if (total >= limit || html.includes('</head>')) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return html;
}
