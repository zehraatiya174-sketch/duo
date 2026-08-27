'use client';

import { Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { usePruneStorage, useAdminStorage } from '@/hooks/use-admin';
import { formatBytes } from '@/utils/datetime';

import { AdminPanel, PanelError, RowsSkeleton } from './admin-shell';

/** Keyed loosely: the route groups by the raw enum, and unknowns fall through. */
const KIND_LABEL: Record<string, string> = {
  IMAGE: 'Images',
  VIDEO: 'Videos',
  AUDIO: 'Audio',
  VOICE_NOTE: 'Voice notes',
  DOCUMENT: 'Documents',
  ARCHIVE: 'Archives',
  GIF: 'GIFs',
  STICKER: 'Stickers',
  OTHER: 'Other',
};

export function StoragePanel(): React.JSX.Element {
  const storage = useAdminStorage();
  const prune = usePruneStorage();
  const { confirm, dialog } = useConfirm();

  const onPrune = (): void => {
    confirm({
      title: 'Delete orphaned uploads?',
      description:
        'These are files that were uploaded but never attached to a message. Deleting them removes the blobs and their rows permanently.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          const result = await prune.mutateAsync();
          toast.success(
            result.pruned === 0
              ? 'Nothing to reclaim'
              : `Reclaimed ${result.pruned} upload${result.pruned === 1 ? '' : 's'}`,
          );
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not prune storage');
        }
      },
    });
  };

  const data = storage.data;
  const total = data?.byKind.reduce((sum, row) => sum + row.bytes, 0) ?? 0;

  return (
    <AdminPanel
      title="Storage"
      description={
        data
          ? `${data.usage.provider} · ${formatBytes(data.usage.trackedBytes)} across ${data.usage.attachmentCount.toLocaleString()} attachments`
          : 'Media usage by type.'
      }
      action={
        <Button
          variant="ghost"
          size="sm"
          disabled={!data || data.orphaned === 0 || prune.isPending}
          loading={prune.isPending}
          onClick={onPrune}
          leadingIcon={<Trash2 aria-hidden />}
        >
          {data && data.orphaned > 0 ? `Prune ${data.orphaned}` : 'Prune'}
        </Button>
      }
    >
      {storage.isLoading ? (
        <RowsSkeleton rows={4} />
      ) : storage.error ? (
        <PanelError error={storage.error} />
      ) : data && data.byKind.length > 0 ? (
        <ul className="divide-y divide-[var(--hairline)]">
          {[...data.byKind]
            .sort((a, b) => b.bytes - a.bytes)
            .map((row) => {
              // Share of tracked bytes, not of the disk: what matters here is
              // which kind of file is responsible for the total.
              const share = total > 0 ? row.bytes / total : 0;
              return (
                <li key={row.kind} className="px-5 py-3.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium text-[var(--text-primary)]">
                      {KIND_LABEL[row.kind] ?? row.kind}
                    </span>
                    <span className="shrink-0 text-[var(--text-muted)] tabular-nums">
                      {row.count.toLocaleString()} · {formatBytes(row.bytes)}
                    </span>
                  </div>
                  <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]"
                    role="img"
                    aria-label={`${Math.round(share * 100)}% of stored bytes`}
                  >
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
                      style={{ width: `${Math.max(share * 100, 1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
        </ul>
      ) : (
        <div className="px-5 py-6">
          <EmptyState title="Nothing stored" description="No attachments have been uploaded yet." />
        </div>
      )}

      {dialog}
    </AdminPanel>
  );
}
