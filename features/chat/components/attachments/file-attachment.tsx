'use client';

import { Download, FileArchive, FileAudio, FileText, FileX, File as FileIcon } from 'lucide-react';
import * as React from 'react';

import { formatBytes, truncate } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';

/** A recognisable glyph beats a generic page icon when scanning a thread. */
function iconFor(mimeType: string): React.ComponentType<{ className?: string }> {
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.startsWith('text/') || mimeType.includes('pdf')) return FileText;
  if (/zip|tar|gzip|rar|7z/.test(mimeType)) return FileArchive;
  return FileIcon;
}

/**
 * A non-media attachment.
 *
 * The download link is rendered only when downloads are permitted — the admin
 * switch and the ephemeral gate both feed `allowDownload`. A disabled-looking
 * button that still worked via the underlying URL would be a false promise, so
 * when downloads are off the anchor is simply not there.
 */
export function FileAttachment({
  attachment,
  allowDownload,
}: {
  attachment: AttachmentDTO;
  allowDownload: boolean;
}): React.JSX.Element {
  const Icon = attachment.purged ? FileX : iconFor(attachment.mimeType);
  const downloadable = allowDownload && !attachment.purged && Boolean(attachment.downloadUrl);

  const body = (
    <>
      <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-current/15">
        <Icon className="size-5" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {truncate(attachment.fileName, 48)}
        </span>
        <span className="block text-xs opacity-70">
          {attachment.purged ? 'No longer available' : formatBytes(attachment.byteSize)}
        </span>
      </span>

      {downloadable ? <Download className="size-4 shrink-0 opacity-70" aria-hidden /> : null}
    </>
  );

  const shell = 'flex items-center gap-3 rounded-[var(--radius-md)] bg-current/10 px-3 py-2';

  if (!downloadable) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <a
      href={attachment.downloadUrl ?? '#'}
      download={attachment.fileName}
      className={`${shell} transition-opacity hover:opacity-85`}
    >
      {body}
    </a>
  );
}
