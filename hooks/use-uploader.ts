'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { uploadWithProgress } from '@/lib/api/client';
import { clientEnv } from '@/lib/env.client';
import { prepareImage, probeVideo } from '@/lib/media/compress';
import { createClientId } from '@/lib/messages/optimistic';
import {
  AUTO_RETRIES,
  CHUNK_THRESHOLD_BYTES,
  isRetryable,
  uploadChunked,
  type ChunkedExtras,
} from '@/lib/uploads/client';
import { backoffDelay, isAbortError, sleep } from '@/lib/utils';
import type { AttachmentDTO } from '@/types/models';
import { formatBytes } from '@/utils/datetime';

export type UploadStatus = 'preparing' | 'uploading' | 'done' | 'error';

export interface UploadDraft {
  /** Local identity. The server's attachment id only exists once it lands. */
  id: string;
  file: File;
  /** Object URL for the local preview, revoked when the draft is dropped. */
  previewUrl: string | null;
  status: UploadStatus;
  progress: number;
  error: string | null;
  attachment: AttachmentDTO | null;
}

export interface UploadExtras {
  /** Peaks captured during recording — the server cannot recover them. */
  waveform?: number[];
  /** Seconds, for voice notes and video. */
  duration?: number;
  /** Intrinsic size of a video, which the server has no decoder to measure. */
  width?: number;
  height?: number;
  /** A frame lifted from a video, stored as its poster. */
  poster?: Blob | null;
}

export interface UploadResult {
  /** Local draft id — what `remove` takes once the attachment has been sent. */
  draftId: string;
  /** Null when that file was rejected or its upload failed. */
  attachment: AttachmentDTO | null;
}

export interface Uploader {
  drafts: UploadDraft[];
  /**
   * Accepts anything file-shaped: input, drop event, or clipboard items.
   * Resolves once every file has settled, so a caller that wants to send
   * immediately — the camera does — does not have to watch `ready`.
   */
  add: (files: Iterable<File>, extras?: UploadExtras) => Promise<UploadResult[]>;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Attachments that finished uploading, in the order they were added. */
  ready: AttachmentDTO[];
  /** True while anything is still preparing or in flight. */
  busy: boolean;
  failed: boolean;
}

/** One request per file, so a slow video does not hide a fast photo's progress. */
interface UploadResponse {
  attachments: AttachmentDTO[];
}

const MAX_FILES = 10;

/** Extensions a browser hands over typeless; treated as video regardless. */
const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m2ts|mts|ts|ogv)$/i;

function isVideo(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSION.test(file.name);
}

/**
 * A local preview only exists for what this browser can actually render, which
 * is narrower than what it can upload: a typeless `.mkv` is still a video to
 * `prepare`, but an element pointed at it would show nothing.
 */
function previewFor(file: File): string | null {
  if (typeof URL === 'undefined') return null;
  return file.type.startsWith('image/') || file.type.startsWith('video/')
    ? URL.createObjectURL(file)
    : null;
}

/**
 * Whatever can be measured or saved before the bytes go up: images are
 * downscaled, videos give up their dimensions, running time and a poster frame.
 * Both are best-effort — a file that cannot be decoded uploads as it is.
 */
async function prepare(file: File, extras: UploadExtras): Promise<{ file: File; extras: UploadExtras }> {
  if (isVideo(file)) {
    const probe = await probeVideo(file);
    return {
      file,
      extras: {
        ...extras,
        // A recorder that measured its own clip knows better than a decoder
        // reading a container it has not finished writing.
        duration: extras.duration ?? probe.duration ?? undefined,
        width: probe.dimensions?.width,
        height: probe.dimensions?.height,
        poster: probe.poster,
      },
    };
  }

  const { file: prepared } = await prepareImage(file);
  return { file: prepared, extras };
}

/**
 * The composer's attachment queue.
 *
 * Files are uploaded the moment they are chosen rather than when the message is
 * sent: by the time a caption has been typed the bytes are usually already on
 * the server, so sending feels instant even for a large photo. Attachments are
 * created detached and only bound to a message when it is sent, which is what
 * makes an abandoned draft harmless.
 */
export function useUploader(): Uploader {
  const [drafts, setDrafts] = React.useState<UploadDraft[]>([]);
  const controllers = React.useRef(new Map<string, AbortController>());
  const extrasRef = React.useRef(new Map<string, UploadExtras>());

  const patch = React.useCallback((id: string, changes: Partial<UploadDraft>): void => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...changes } : draft)),
    );
  }, []);

  const upload = React.useCallback(
    async (id: string, file: File, extras: UploadExtras): Promise<AttachmentDTO | null> => {
      const controller = new AbortController();
      controllers.current.set(id, controller);

      // `poster` is a Blob and travels only in the multipart body; everything
      // else is measurement that both upload paths accept.
      const { poster: _poster, ...measured } = extras;
      const chunked = file.size > CHUNK_THRESHOLD_BYTES;

      const buildForm = (): FormData => {
        const form = new FormData();
        form.append('files', file, file.name);
        if (extras.waveform?.length) form.append('waveform', JSON.stringify(extras.waveform));
        if (extras.duration !== undefined) form.append('duration', String(extras.duration));
        if (extras.width !== undefined) form.append('width', String(extras.width));
        if (extras.height !== undefined) form.append('height', String(extras.height));
        if (extras.poster) form.append('poster', extras.poster, 'poster.webp');
        return form;
      };

      const sendWhole = async (): Promise<AttachmentDTO> => {
        const response = await uploadWithProgress<UploadResponse>('/api/uploads', buildForm(), {
          onProgress: (percent) => patch(id, { progress: percent }),
          signal: controller.signal,
        });
        const attachment = response.attachments[0];
        if (!attachment) throw new Error('The upload returned no attachment');
        return attachment;
      };

      try {
        for (let attempt = 0; ; attempt += 1) {
          patch(id, { status: 'uploading', progress: 0, error: null });

          try {
            const attachment = chunked
              ? await uploadChunked(file, measured satisfies ChunkedExtras, {
                  onProgress: (percent) => patch(id, { progress: percent }),
                  signal: controller.signal,
                })
              : await sendWhole();

            patch(id, { status: 'done', progress: 100, attachment });
            return attachment;
          } catch (error) {
            // An abort is a deliberate removal, not a failure worth reporting.
            if (isAbortError(error)) return null;

            // A chunked upload has already retried the part that failed. Going
            // round again would re-send the entire file for the same reason it
            // failed the first time, which on a large video is the most
            // expensive possible way to fail twice.
            if (chunked || attempt >= AUTO_RETRIES || !isRetryable(error)) {
              patch(id, {
                status: 'error',
                progress: 0,
                error: error instanceof Error ? error.message : 'Upload failed',
              });
              return null;
            }

            await sleep(backoffDelay(attempt, 500, 4000));
            if (controller.signal.aborted) return null;
          }
        }
      } finally {
        controllers.current.delete(id);
      }
    },
    [patch],
  );

  const add = React.useCallback(
    async (files: Iterable<File>, extras: UploadExtras = {}): Promise<UploadResult[]> => {
      const incoming = Array.from(files);
      if (incoming.length === 0) return [];

      const room = MAX_FILES - drafts.length;
      if (room <= 0) {
        toast.error(`You can attach at most ${MAX_FILES} files to one message`);
        return [];
      }

      const accepted: File[] = [];
      for (const file of incoming.slice(0, room)) {
        if (file.size > clientEnv.NEXT_PUBLIC_MAX_UPLOAD_BYTES) {
          toast.error(
            `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(
              clientEnv.NEXT_PUBLIC_MAX_UPLOAD_BYTES,
            )}`,
          );
          continue;
        }
        accepted.push(file);
      }

      if (incoming.length > room) {
        toast.error(`Only the first ${room} of those files were added`);
      }
      if (accepted.length === 0) return [];

      const queued = accepted.map((file) => ({
        id: createClientId(),
        file,
        previewUrl: previewFor(file),
        status: 'preparing' as const,
        progress: 0,
        error: null,
        attachment: null,
      }));

      setDrafts((current) => [...current, ...queued]);

      // Prepare and upload in parallel: decoding is CPU-bound and uploads are
      // network-bound, so serialising them would idle both.
      return Promise.all(
        queued.map(async (draft) => {
          const prepared = await prepare(draft.file, extras);
          // Stored enriched, so a manual retry does not have to probe again.
          extrasRef.current.set(draft.id, prepared.extras);
          if (prepared.file !== draft.file) patch(draft.id, { file: prepared.file });
          return {
            draftId: draft.id,
            attachment: await upload(draft.id, prepared.file, prepared.extras),
          };
        }),
      );
    },
    [drafts.length, patch, upload],
  );

  const retry = React.useCallback(
    (id: string): void => {
      const draft = drafts.find((item) => item.id === id);
      if (!draft) return;
      void upload(id, draft.file, extrasRef.current.get(id) ?? {});
    },
    [drafts, upload],
  );

  const remove = React.useCallback((id: string): void => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    extrasRef.current.delete(id);

    setDrafts((current) => {
      const draft = current.find((item) => item.id === id);
      if (draft?.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clear = React.useCallback((): void => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    extrasRef.current.clear();

    setDrafts((current) => {
      for (const draft of current) {
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      }
      return [];
    });
  }, []);

  // Object URLs outlive the component unless they are released explicitly.
  const draftsRef = React.useRef(drafts);
  draftsRef.current = drafts;
  React.useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      for (const draft of draftsRef.current) {
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      }
    },
    [],
  );

  const ready = React.useMemo(
    () =>
      drafts
        .map((draft) => draft.attachment)
        .filter((attachment): attachment is AttachmentDTO => attachment !== null),
    [drafts],
  );

  return {
    drafts,
    add,
    retry,
    remove,
    clear,
    ready,
    busy: drafts.some((draft) => draft.status === 'preparing' || draft.status === 'uploading'),
    failed: drafts.some((draft) => draft.status === 'error'),
  };
}
