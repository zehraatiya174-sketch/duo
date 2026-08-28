import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { messageTypeFor } from '@/lib/messages/optimistic';
import type { AttachmentDTO } from '@/types/models';

/**
 * Getting an uploaded file onto a message.
 *
 * This is the seam a video fell through: uploads succeeded, the attachment row
 * existed, and then the composer sent a message that referenced none of them.
 * The parent was resolving ids against the attachments of messages *already in
 * the conversation* — where a freshly uploaded, still-detached attachment can
 * never appear — so the list was always empty and the server answered "A
 * message needs text, an attachment, or a location".
 *
 * The contract these tests pin is that the composer hands over the attachment
 * objects it already holds, so nothing has to be looked up at all.
 */

const uploader = {
  drafts: [] as unknown[],
  ready: [] as AttachmentDTO[],
  busy: false,
  failed: false,
  add: vi.fn(),
  retry: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
};

vi.mock('@/hooks/use-uploader', () => ({ useUploader: () => uploader }));
vi.mock('@/components/providers/preferences-provider', () => ({
  usePreferences: () => ({ settings: { enterToSend: true }, update: vi.fn() }),
}));

const { Composer } = await import('@/features/chat/components/composer/composer');

function attachment(overrides: Partial<AttachmentDTO> = {}): AttachmentDTO {
  return {
    id: 'attachment-1',
    kind: 'VIDEO',
    fileName: 'clip.webm',
    mimeType: 'video/webm',
    byteSize: 2048,
    width: null,
    height: null,
    duration: 3,
    waveform: [],
    blurDataUrl: null,
    url: '/api/media/attachment-1',
    thumbnailUrl: null,
    downloadUrl: '/api/media/attachment-1',
    purged: false,
    ...overrides,
  } as AttachmentDTO;
}

function renderComposer(onSend = vi.fn()) {
  // Mounted once in `AppProviders` in the real app; the composer's hints need
  // it in place or Radix throws.
  render(
    <TooltipProvider>
      <Composer replyTo={null} onCancelReply={vi.fn()} onTyping={vi.fn()} onSend={onSend} />
    </TooltipProvider>,
  );
  return onSend;
}

describe('the composer hands over its finished uploads', () => {
  it('sends the attachment objects, not ids that would have to be resolved', async () => {
    uploader.ready = [attachment()];
    const onSend = renderComposer();

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledOnce();
    const input = onSend.mock.calls[0]![0] as { attachments: AttachmentDTO[]; body: string };
    expect(input.attachments).toHaveLength(1);
    expect(input.attachments[0]!.id).toBe('attachment-1');
    expect(input.body).toBe('');
  });

  it('reads the attachments before clearing the tray', async () => {
    // `clear()` empties `ready`, so reading it afterwards would send nothing —
    // which is the same empty-attachment bug by a different route.
    uploader.ready = [attachment()];
    let readyWhenCleared: number | null = null;
    uploader.clear = vi.fn(() => {
      uploader.ready = [];
    });

    const onSend = vi.fn((input: { attachments: AttachmentDTO[] }) => {
      readyWhenCleared = input.attachments.length;
    });
    renderComposer(onSend);

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(uploader.clear).toHaveBeenCalled();
    expect(readyWhenCleared).toBe(1);
  });

  it('can send an attachment with no caption at all', async () => {
    uploader.ready = [attachment()];
    const onSend = renderComposer();

    // The button must not be disabled just because the text box is empty: a
    // video with no caption is the most common thing anyone sends.
    expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledOnce();
  });
});

describe('message type follows the attachment kind', () => {
  it('types a video as VIDEO, not IMAGE', () => {
    expect(messageTypeFor([attachment({ kind: 'VIDEO' })])).toBe('VIDEO');
  });

  it.each([
    ['IMAGE', 'IMAGE'],
    ['AUDIO', 'AUDIO'],
    ['VOICE_NOTE', 'VOICE_NOTE'],
    ['GIF', 'GIF'],
    ['STICKER', 'STICKER'],
    ['DOCUMENT', 'DOCUMENT'],
    // Neither has its own renderer; both are offered as a download.
    ['ARCHIVE', 'DOCUMENT'],
    ['OTHER', 'DOCUMENT'],
  ] as const)('maps %s to %s', (kind, expected) => {
    expect(messageTypeFor([attachment({ kind })])).toBe(expected);
  });

  it('falls back to TEXT with nothing attached', () => {
    expect(messageTypeFor([])).toBe('TEXT');
  });

  it('takes its type from the first attachment', () => {
    const type = messageTypeFor([
      attachment({ id: 'a', kind: 'VIDEO' }),
      attachment({ id: 'b', kind: 'IMAGE' }),
    ]);
    expect(type).toBe('VIDEO');
  });
});
