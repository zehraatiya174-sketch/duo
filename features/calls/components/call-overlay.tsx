'use client';

import { motion } from 'framer-motion';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  ShieldAlert,
  Video,
  VideoOff,
} from 'lucide-react';
import * as React from 'react';

import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import type { CallSession } from '@/hooks/use-call';
import type { CallStatsSnapshot } from '@/lib/calls/peer';
import { fade, scaleIn, springSoft } from '@/lib/motion';
import { cn, formatDuration } from '@/lib/utils';
import type { PublicProfile } from '@/types/models';

/** Signal bars, from the sampled link quality. */
type Quality = 'good' | 'fair' | 'poor';

function qualityOf(stats: CallStatsSnapshot): Quality {
  if (stats.lossRatio > 0.08 || (stats.rttMs !== null && stats.rttMs > 500)) return 'poor';
  if (stats.lossRatio > 0.02 || (stats.rttMs !== null && stats.rttMs > 250)) return 'fair';
  return 'good';
}

const QUALITY_LABEL: Record<Quality, string> = {
  good: 'Good connection',
  fair: 'Unstable connection',
  poor: 'Poor connection',
};

const QUALITY_COLOUR: Record<Quality, string> = {
  good: 'bg-[var(--color-positive)]',
  fair: 'bg-[var(--color-warning)]',
  poor: 'bg-[var(--color-danger)]',
};

const PHASE_LABEL: Record<CallSession['phase'], string> = {
  dialling: 'Calling…',
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  connected: '',
  reconnecting: 'Reconnecting…',
};

/**
 * Binds a `MediaStream` to a media element.
 *
 * `srcObject` is not an attribute, so it cannot be set through JSX — and
 * reassigning it when the stream is unchanged restarts playback, which shows up
 * as a visible flicker every render.
 */
function useStream(stream: MediaStream | null): React.RefObject<HTMLVideoElement | null> {
  const ref = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject === stream) return;
    element.srcObject = stream;
    if (stream) void element.play().catch(() => undefined);
  }, [stream]);

  return ref;
}

/** Ticks once a second, but only while the call is actually up. */
function useElapsed(since: number | null): number {
  const [seconds, setSeconds] = React.useState(0);

  React.useEffect(() => {
    if (since === null) {
      setSeconds(0);
      return;
    }

    const update = (): void => setSeconds(Math.floor((Date.now() - since) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  return seconds;
}

function SignalBars({ quality }: { quality: Quality }): React.JSX.Element {
  const lit = quality === 'good' ? 3 : quality === 'fair' ? 2 : 1;

  return (
    <span className="flex items-end gap-0.5" role="img" aria-label={QUALITY_LABEL[quality]}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            'w-1 rounded-full transition-colors',
            index === 0 ? 'h-1.5' : index === 1 ? 'h-2.5' : 'h-3.5',
            index < lit ? QUALITY_COLOUR[quality] : 'bg-[var(--text-muted)]/35',
          )}
        />
      ))}
    </span>
  );
}

export interface CallOverlayProps {
  session: CallSession;
  peer: PublicProfile | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Warns that a relay is unavailable, which is where calls silently fail. */
  hasTurn: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onHangUp: () => void;
}

/**
 * The in-call surface.
 *
 * It covers the app rather than docking beside it: a call is a modal activity,
 * and the alternative — a floating window over a live conversation — makes both
 * halves cramped on exactly the screens where calls are most common.
 */
export function CallOverlay({
  session,
  peer,
  localStream,
  remoteStream,
  hasTurn,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onHangUp,
}: CallOverlayProps): React.JSX.Element {
  const remoteRef = useStream(remoteStream);
  const localRef = useStream(localStream);
  const [expanded, setExpanded] = React.useState(false);

  const elapsed = useElapsed(session.connectedAt);
  const quality = qualityOf(session.stats);
  const name = peer?.displayName ?? 'Your contact';

  const remoteHasVideo = React.useMemo(
    () => (remoteStream?.getVideoTracks() ?? []).some((track) => track.readyState === 'live'),
    [remoteStream],
  );
  const showLocalPreview = session.cameraOn || session.sharingScreen;

  // Escape hangs up rather than merely dismissing: there is nothing underneath
  // to return to while a call is running, so a hidden live call is worse.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onHangUp();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onHangUp]);

  const status =
    session.phase === 'connected' ? formatDuration(elapsed) : PHASE_LABEL[session.phase];

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${name}`}
      variants={fade}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--canvas)]/95 backdrop-blur-2xl"
    >
      {/* Stage ---------------------------------------------------------- */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {/* Kept mounted and merely hidden for an audio call: unmounting the
            element would stop the remote audio along with the picture. */}
        <video
          ref={remoteRef}
          autoPlay
          playsInline
          className={cn(
            'h-full w-full bg-black object-contain',
            !remoteHasVideo && 'invisible absolute',
          )}
        />

        {!remoteHasVideo ? (
          <motion.div
            variants={scaleIn}
            initial="hidden"
            animate="visible"
            className="flex flex-col items-center gap-5 px-6 text-center"
          >
            <span className="relative">
              {session.phase !== 'connected' ? (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-[var(--accent)]/25"
                  animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0, 0.5] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                />
              ) : null}
              <Avatar size="2xl" src={peer?.avatarUrl} name={name} />
            </span>

            <div className="space-y-1">
              <h2 className="text-2xl font-semibold text-[var(--text-primary)]">{name}</h2>
              <p className="text-sm text-[var(--text-secondary)]" aria-live="polite">
                {status || 'Connected'}
              </p>
            </div>
          </motion.div>
        ) : null}

        {/* Header chips ------------------------------------------------- */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
          <div className="glass flex items-center gap-2.5 rounded-full px-3.5 py-2">
            <SignalBars quality={quality} />
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {remoteHasVideo ? name : status || 'Connected'}
            </span>
            {remoteHasVideo && status ? (
              <span className="text-sm text-[var(--text-secondary)] tabular-nums">{status}</span>
            ) : null}
          </div>

          {session.stats.transport === 'relay' ? (
            <span className="glass rounded-full px-3 py-1.5 text-xs text-[var(--text-secondary)]">
              Relayed
            </span>
          ) : null}
        </div>

        {!hasTurn && session.phase !== 'connected' ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <p className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-xs text-[var(--text-secondary)]">
              <ShieldAlert className="size-3.5 text-[var(--color-warning)]" aria-hidden />
              No relay server is configured — this call may not connect on some networks.
            </p>
          </div>
        ) : null}

        {/* Local preview ------------------------------------------------ */}
        {showLocalPreview ? (
          <motion.div
            layout
            transition={springSoft}
            className={cn(
              'absolute overflow-hidden rounded-[var(--radius-lg)] border border-[var(--hairline-strong)]',
              'bg-black shadow-[var(--shadow-float)]',
              expanded
                ? 'inset-4 sm:inset-10'
                : 'right-4 bottom-4 h-32 w-24 sm:h-40 sm:w-28 md:h-44 md:w-64',
            )}
          >
            <video
              ref={localRef}
              autoPlay
              playsInline
              muted
              className={cn(
                'h-full w-full',
                session.sharingScreen ? 'object-contain' : 'scale-x-[-1] object-cover',
              )}
            />
            <Button
              variant="secondary"
              size="icon-sm"
              className="absolute top-1.5 right-1.5"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? 'Shrink your preview' : 'Enlarge your preview'}
            >
              {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </Button>
          </motion.div>
        ) : null}
      </div>

      {/* Controls --------------------------------------------------------- */}
      <div className="glass-strong flex items-center justify-center gap-3 border-t border-[var(--border)] px-4 py-5 sm:gap-4">
        <Hint label={session.micOn ? 'Mute' : 'Unmute'}>
          <Button
            variant={session.micOn ? 'secondary' : 'danger'}
            size="icon-lg"
            onClick={onToggleMic}
            aria-pressed={!session.micOn}
            aria-label={session.micOn ? 'Mute your microphone' : 'Unmute your microphone'}
          >
            {session.micOn ? <Mic aria-hidden /> : <MicOff aria-hidden />}
          </Button>
        </Hint>

        <Hint label={session.cameraOn ? 'Turn camera off' : 'Turn camera on'}>
          <Button
            variant={session.cameraOn ? 'subtle' : 'secondary'}
            size="icon-lg"
            onClick={onToggleCamera}
            disabled={session.sharingScreen}
            aria-pressed={session.cameraOn}
            aria-label={session.cameraOn ? 'Turn your camera off' : 'Turn your camera on'}
          >
            {session.cameraOn ? <Video aria-hidden /> : <VideoOff aria-hidden />}
          </Button>
        </Hint>

        <Hint label={session.sharingScreen ? 'Stop sharing' : 'Share your screen'}>
          <Button
            variant={session.sharingScreen ? 'subtle' : 'secondary'}
            size="icon-lg"
            onClick={onToggleScreenShare}
            aria-pressed={session.sharingScreen}
            aria-label={session.sharingScreen ? 'Stop sharing your screen' : 'Share your screen'}
          >
            <MonitorUp aria-hidden />
          </Button>
        </Hint>

        <Hint label="End call">
          <Button
            variant="danger"
            size="icon-lg"
            className="ml-2 sm:ml-6"
            onClick={onHangUp}
            aria-label="End the call"
          >
            <PhoneOff aria-hidden />
          </Button>
        </Hint>
      </div>
    </motion.div>
  );
}
