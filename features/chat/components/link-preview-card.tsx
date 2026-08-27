'use client';

import * as React from 'react';

import { truncate } from '@/lib/utils';
import type { LinkPreviewDTO } from '@/types/models';

/**
 * An Open Graph card under a message containing a link.
 *
 * The image is a plain `<img>` rather than `next/image`: previews point at
 * arbitrary third-party hosts, and `next/image` would need every one of them
 * allowlisted in `next.config.ts` — or, worse, the allowlist opened to `**`.
 * A broken image hides itself rather than leaving a torn placeholder.
 */
export function LinkPreviewCard({ preview }: { preview: LinkPreviewDTO }): React.JSX.Element {
  const [imageFailed, setImageFailed] = React.useState(false);

  let host = preview.siteName;
  if (!host) {
    try {
      host = new URL(preview.url).hostname;
    } catch {
      host = null;
    }
  }

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="block overflow-hidden rounded-[var(--radius-md)] bg-current/10 transition-opacity hover:opacity-85"
    >
      {preview.imageUrl && !imageFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="aspect-[1.91/1] w-full object-cover"
        />
      ) : null}

      <div className="flex flex-col gap-0.5 px-3 py-2">
        {host ? (
          <span className="truncate text-[0.6875rem] font-medium uppercase opacity-70">
            {host}
          </span>
        ) : null}

        {preview.title ? (
          <span className="line-clamp-2 text-sm font-medium">{preview.title}</span>
        ) : null}

        {preview.description ? (
          <span className="line-clamp-2 text-xs opacity-75">
            {truncate(preview.description, 160)}
          </span>
        ) : null}
      </div>
    </a>
  );
}
