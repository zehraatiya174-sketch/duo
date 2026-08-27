'use client';

import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSystemHealth } from '@/hooks/use-admin';
import { stagger } from '@/lib/motion';
import { queryKeys } from '@/lib/query-keys';

import { StatusDot } from './admin-shell';
import { AnalyticsPanel } from './analytics-panel';
import { AuditPanel } from './audit-panel';
import { CallsPanel } from './calls-panel';
import { ControlsPanel } from './controls-panel';
import { DatabasePanel } from './database-panel';
import { DevicesPanel } from './devices-panel';
import { ErrorsPanel } from './errors-panel';
import { HealthPanel } from './health-panel';
import { MediaLibraryPanel } from './media-library-panel';
import { OverviewPanel } from './overview-panel';
import { SessionsPanel } from './sessions-panel';
import { StoragePanel } from './storage-panel';
import { UploadsPanel } from './uploads-panel';
import { UsersPanel } from './users-panel';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'system', label: 'System' },
  { value: 'people', label: 'People' },
  { value: 'storage', label: 'Storage' },
  { value: 'media', label: 'Media' },
  { value: 'calls', label: 'Calls' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'controls', label: 'Controls' },
  { value: 'audit', label: 'Audit' },
] as const;

/**
 * The single-operator console.
 *
 * Each pane owns its own polling, so switching tabs neither refetches what is
 * already fresh nor keeps five intervals running behind a pane nobody is
 * looking at — an unmounted `useQuery` stops polling on its own.
 */
export function AdminDashboard(): React.JSX.Element {
  const client = useQueryClient();
  const health = useSystemHealth();

  const [refreshing, setRefreshing] = React.useState(false);

  const refreshAll = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await client.invalidateQueries({ queryKey: queryKeys.admin.all() });
    } finally {
      setRefreshing(false);
    }
  };

  const status = health.data?.status;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-24 sm:px-6">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/" aria-label="Back to conversation">
              <ArrowLeft aria-hidden />
            </Link>
          </Button>

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
              Admin
            </h1>
            <p className="text-xs text-[var(--text-muted)]">
              Operational view of this deployment. Nothing here is visible to the other account.
            </p>
          </div>

          {status ? (
            <StatusDot
              tone={status === 'healthy' ? 'positive' : 'danger'}
              label={status === 'healthy' ? 'All systems normal' : 'Degraded'}
              pulse={status === 'healthy'}
            />
          ) : null}

          <Button
            variant="secondary"
            size="sm"
            loading={refreshing}
            onClick={() => void refreshAll()}
            leadingIcon={<RefreshCw aria-hidden />}
          >
            Refresh
          </Button>
        </header>

        <Tabs defaultValue="overview">
          <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            <TabsList className="w-max">
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <OverviewPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="system">
            <motion.div
              variants={stagger(0.05)}
              initial="hidden"
              animate="visible"
              className="space-y-4"
            >
              <HealthPanel />
              <DatabasePanel />
              <ErrorsPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="people">
            <motion.div
              variants={stagger(0.05)}
              initial="hidden"
              animate="visible"
              className="space-y-4"
            >
              <UsersPanel />
              <SessionsPanel />
              <DevicesPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="storage">
            <motion.div
              variants={stagger(0.05)}
              initial="hidden"
              animate="visible"
              className="space-y-4"
            >
              <StoragePanel />
              <UploadsPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="media">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <MediaLibraryPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="calls">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <CallsPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="analytics">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <AnalyticsPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="controls">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <ControlsPanel />
            </motion.div>
          </TabsContent>

          <TabsContent value="audit">
            <motion.div variants={stagger(0.05)} initial="hidden" animate="visible">
              <AuditPanel />
            </motion.div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
