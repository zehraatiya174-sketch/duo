'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { useSocket, useSocketEvent } from '@/components/providers/socket-provider';
import { api } from '@/lib/api/client';
import {
  applyBitrate,
  captureLocalMedia,
  captureScreen,
  createPeer,
  EMPTY_STATS,
  nextBitrate,
  sampleStats,
  stopStream,
  type CallStatsSnapshot,
  type PeerHandles,
} from '@/lib/calls/peer';
import type { CallKind, IceConfigDTO } from '@/types/models';

export type CallPhase = 'dialling' | 'ringing' | 'connecting' | 'connected' | 'reconnecting';

export type CallRole = 'caller' | 'callee';

export interface IncomingCall {
  callId: string;
  chatId: string;
  from: string;
  kind: CallKind;
  sdp: { type: string; sdp?: string };
}

export interface CallSession {
  callId: string;
  kind: CallKind;
  role: CallRole;
  phase: CallPhase;
  /** Set when the media path first comes up, for the duration counter. */
  connectedAt: number | null;
  micOn: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
  stats: CallStatsSnapshot;
  /** True once ICE has been restarted at least once during this call. */
  recovered: boolean;
}

export interface CallController {
  session: CallSession | null;
  incoming: IncomingCall | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** False when no TURN relay is configured, so calls can fail behind NAT. */
  hasTurn: boolean;
  start: (kind: CallKind) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangUp: (reason?: string) => void;
  toggleMic: () => void;
  toggleCamera: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
}

/** How often stats are sampled, reported and fed to the bitrate controller. */
const STATS_INTERVAL_MS = 3_000;

/** A dropped media path is given this long to recover before an ICE restart. */
const RECOVERY_GRACE_MS = 2_500;

/** ICE restarts are bounded; past this the call is genuinely lost. */
const MAX_ICE_RESTARTS = 3;

/**
 * How long the media path has to come up after both sides have exchanged SDP.
 *
 * Past this the negotiation has plainly failed rather than merely being slow —
 * usually a NAT that neither side's candidates can cross — and the only thing
 * that helps is a fresh gathering round.
 */
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * Cap on candidates buffered for a call that has no peer connection yet.
 *
 * Generous enough for a dual-stack host behind a relay, bounded so a peer that
 * never answers cannot grow the buffer without limit.
 */
const MAX_BUFFERED_CANDIDATES = 256;

const INITIAL_BITRATE_KBPS = 2500;

function describeMediaError(error: unknown): string {
  if (!(error instanceof Error)) return 'Could not access your microphone or camera';
  switch (error.name) {
    case 'NotAllowedError':
      return 'Permission to use the microphone or camera was denied';
    case 'NotFoundError':
      return 'No microphone or camera was found';
    case 'NotReadableError':
      return 'Your microphone or camera is already in use by another app';
    default:
      return error.message || 'Could not access your microphone or camera';
  }
}

function toDescription(sdp: { type: string; sdp?: string }): RTCSessionDescriptionInit {
  return { type: sdp.type as RTCSdpType, ...(sdp.sdp ? { sdp: sdp.sdp } : {}) };
}

function fromDescription(description: RTCSessionDescriptionInit): { type: string; sdp?: string } {
  return { type: description.type, ...(description.sdp ? { sdp: description.sdp } : {}) };
}

/**
 * The call lifecycle: signalling, the peer connection, and the controls.
 *
 * Only the caller ever creates an offer. With exactly two participants and one
 * conversation there is no scenario where both sides negotiate at once, so the
 * usual "polite peer" glare handling is unnecessary — and the recovery path
 * stays simple enough to reason about at the moment a call actually drops.
 *
 * Long-lived state that event handlers need lives in refs rather than in state:
 * the peer connection's listeners are registered once, and a handler that closed
 * over the first render's `session` would be permanently stale.
 */
export function useCall(chatId: string | null, selfId: string): CallController {
  const { request, emit, status: socketStatus } = useSocket();

  // Read from inside long-lived peer listeners, which cannot see render scope.
  const socketStatusRef = React.useRef(socketStatus);
  socketStatusRef.current = socketStatus;

  const [session, setSession] = React.useState<CallSession | null>(null);
  const [incoming, setIncoming] = React.useState<IncomingCall | null>(null);
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = React.useState<MediaStream | null>(null);
  const [iceConfig, setIceConfig] = React.useState<IceConfigDTO | null>(null);

  const peerRef = React.useRef<PeerHandles | null>(null);
  const localRef = React.useRef<MediaStream | null>(null);
  const cameraRef = React.useRef<MediaStreamTrack | null>(null);
  const screenRef = React.useRef<MediaStream | null>(null);
  const callIdRef = React.useRef<string | null>(null);
  const roleRef = React.useRef<CallRole | null>(null);

  /** Remote candidates that arrive before the remote description is applied. */
  const remoteIce = React.useRef<RTCIceCandidateInit[]>([]);
  /** Local candidates gathered before the server has issued a call id. */
  const localIce = React.useRef<RTCIceCandidateInit[]>([]);
  /**
   * Remote candidates for a call this side has no peer connection for yet.
   *
   * The caller finishes gathering and flushes its candidates within a moment of
   * the invite being acknowledged — long before the callee has decided whether
   * to pick up. Those candidates used to be dropped on the floor because
   * `peerRef` was still null, which left the callee's connection with nothing
   * to check against and stranded the call in `connecting` forever. Keyed by
   * call id so a stale invite cannot poison the next one.
   */
  const bufferedIce = React.useRef(new Map<string, RTCIceCandidateInit[]>());

  const restartsRef = React.useRef(0);
  const recoveryTimer = React.useRef<number | null>(null);
  const connectTimer = React.useRef<number | null>(null);
  const bitrateRef = React.useRef<number>(INITIAL_BITRATE_KBPS);

  const patch = React.useCallback((changes: Partial<CallSession>): void => {
    setSession((current) => (current ? { ...current, ...changes } : current));
  }, []);

  // --- Teardown ------------------------------------------------------------

  const teardown = React.useCallback((): void => {
    if (recoveryTimer.current !== null) {
      window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    }
    if (connectTimer.current !== null) {
      window.clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }

    peerRef.current?.connection.close();
    peerRef.current = null;

    stopStream(localRef.current);
    stopStream(screenRef.current);
    cameraRef.current?.stop();

    localRef.current = null;
    screenRef.current = null;
    cameraRef.current = null;
    remoteIce.current = [];
    localIce.current = [];
    bufferedIce.current.clear();
    callIdRef.current = null;
    roleRef.current = null;
    restartsRef.current = 0;
    bitrateRef.current = INITIAL_BITRATE_KBPS;

    setLocalStream(null);
    setRemoteStream(null);
    setSession(null);
  }, []);

  // Never leave the camera on because the tab was closed mid-call.
  React.useEffect(() => teardown, [teardown]);

  const hangUp = React.useCallback(
    (reason = 'hangup'): void => {
      const callId = callIdRef.current;
      if (callId) emit('call:end', { callId, reason });
      teardown();
    },
    [emit, teardown],
  );

  // --- ICE configuration ---------------------------------------------------

  const loadIceConfig = React.useCallback(async (): Promise<IceConfigDTO> => {
    // Re-fetched per call rather than cached indefinitely: TURN credentials are
    // short-lived by design, and a stale one fails only once media is needed.
    const config = await api.get<IceConfigDTO>('/api/calls/ice-servers');
    setIceConfig(config);
    return config;
  }, []);

  React.useEffect(() => {
    void loadIceConfig().catch(() => {
      // Not fatal at rest; a call attempt surfaces the failure where it matters.
    });
  }, [loadIceConfig]);

  // --- Recovery ------------------------------------------------------------

  const restartIce = React.useCallback(
    async (reason = 'ice-failed'): Promise<void> => {
      const handles = peerRef.current;
      const callId = callIdRef.current;
      if (!handles || !callId) return;

      // Only the offerer may re-offer, so a callee that notices the path has
      // died asks rather than acts. Without this the side that detects the
      // failure first is frequently the side that cannot do anything about it.
      if (roleRef.current !== 'caller') {
        patch({ phase: 'reconnecting', recovered: true });
        emit('call:restart', { callId, reason });
        return;
      }

      if (restartsRef.current >= MAX_ICE_RESTARTS) {
        toast.error('The call was lost');
        hangUp('connection-lost');
        return;
      }

      restartsRef.current += 1;
      patch({ phase: 'reconnecting', recovered: true });

      try {
        // Credentials are short-lived, and a restart is exactly when a stale
        // one would bite: re-fetching costs one round trip and removes the
        // failure mode where every retry reuses the expired relay password.
        const config = await loadIceConfig().catch(() => null);
        if (config) {
          handles.connection.setConfiguration({
            iceServers: config.iceServers,
            iceCandidatePoolSize: 8,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceTransportPolicy: config.iceTransportPolicy,
          });
        }

        const offer = await handles.connection.createOffer({ iceRestart: true });
        await handles.connection.setLocalDescription(offer);
        emit('call:renegotiate', { callId, sdp: fromDescription(offer) });
      } catch {
        toast.error('Could not recover the connection');
        hangUp('renegotiation-failed');
      }
    },
    [emit, hangUp, loadIceConfig, patch],
  );

  /**
   * Fails the call over to a fresh gathering round if it never came up.
   *
   * Armed once both sides have SDP. A connection that is going to succeed does
   * so in a second or two; one still `connecting` well past that is not slow,
   * it is stuck, and only new candidates will change that.
   */
  const armConnectWatchdog = React.useCallback((): void => {
    if (connectTimer.current !== null) window.clearTimeout(connectTimer.current);

    connectTimer.current = window.setTimeout(() => {
      connectTimer.current = null;
      const state = peerRef.current?.connection.connectionState;
      if (state === 'connected') return;
      void restartIce('connect-timeout');
    }, CONNECT_TIMEOUT_MS);
  }, [restartIce]);

  /**
   * A `disconnected` state often heals on its own — a Wi-Fi handover, a moment
   * of congestion. Restarting ICE immediately would tear down a path that was
   * about to come back, so the restart waits out a grace period first.
   */
  const scheduleRecovery = React.useCallback((): void => {
    if (recoveryTimer.current !== null) return;

    recoveryTimer.current = window.setTimeout(() => {
      recoveryTimer.current = null;
      if (peerRef.current?.connection.connectionState === 'connected') return;
      void restartIce();
    }, RECOVERY_GRACE_MS);
  }, [restartIce]);

  const drainRemoteIce = React.useCallback(async (connection: RTCPeerConnection): Promise<void> => {
    const callId = callIdRef.current;
    const buffered = callId ? (bufferedIce.current.get(callId) ?? []) : [];
    if (callId) bufferedIce.current.delete(callId);

    const queued = [...buffered, ...remoteIce.current];
    remoteIce.current = [];

    for (const candidate of queued) {
      try {
        await connection.addIceCandidate(candidate);
      } catch {
        // A candidate for an m-line that was since renegotiated away is stale,
        // not an error worth surfacing.
      }
    }
  }, []);

  /** Flushes candidates gathered before the server issued the call id. */
  const flushLocalIce = React.useCallback(
    (callId: string): void => {
      const queued = localIce.current;
      localIce.current = [];
      for (const candidate of queued) {
        emit('call:ice', {
          callId,
          candidate: {
            candidate: candidate.candidate ?? '',
            sdpMid: candidate.sdpMid ?? null,
            sdpMLineIndex: candidate.sdpMLineIndex ?? null,
            ...(candidate.usernameFragment ? { usernameFragment: candidate.usernameFragment } : {}),
          },
        });
      }
    },
    [emit],
  );

  // --- Peer wiring ---------------------------------------------------------

  /**
   * Registered immediately after the connection is built, before any offer is
   * created — ICE gathering starts at `setLocalDescription`, and the caller does
   * not have a call id until the invite is acknowledged. Candidates gathered in
   * that window are queued rather than dropped.
   */
  const attachPeer = React.useCallback(
    (handles: PeerHandles): void => {
      const { connection } = handles;

      connection.addEventListener('icecandidate', (event) => {
        if (!event.candidate) return;

        const init: RTCIceCandidateInit = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          ...(event.candidate.usernameFragment
            ? { usernameFragment: event.candidate.usernameFragment }
            : {}),
        };

        // Queued when there is no call id yet, and equally when the socket is
        // down: a fire-and-forget emit over a closed connection is discarded
        // silently, and a lost candidate is indistinguishable from a call that
        // simply refuses to connect.
        const callId = callIdRef.current;
        if (!callId || socketStatusRef.current !== 'connected') {
          localIce.current.push(init);
          return;
        }

        emit('call:ice', {
          callId,
          candidate: {
            candidate: init.candidate ?? '',
            sdpMid: init.sdpMid ?? null,
            sdpMLineIndex: init.sdpMLineIndex ?? null,
            ...(init.usernameFragment ? { usernameFragment: init.usernameFragment } : {}),
          },
        });
      });

      connection.addEventListener('track', (event) => {
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
          return;
        }
        // Some browsers omit the stream for a track that arrived via
        // `replaceTrack`; assembling one keeps the video element fed.
        setRemoteStream((current) => {
          const target = current ?? new MediaStream();
          target.addTrack(event.track);
          return target;
        });
      });

      const onState = (state: RTCPeerConnectionState | RTCIceConnectionState): void => {
        if (state === 'connected' || state === 'completed') {
          if (recoveryTimer.current !== null) {
            window.clearTimeout(recoveryTimer.current);
            recoveryTimer.current = null;
          }
          if (connectTimer.current !== null) {
            window.clearTimeout(connectTimer.current);
            connectTimer.current = null;
          }
          restartsRef.current = 0;
          setSession((current) =>
            current
              ? { ...current, phase: 'connected', connectedAt: current.connectedAt ?? Date.now() }
              : current,
          );
          return;
        }

        if (state === 'disconnected') {
          patch({ phase: 'reconnecting' });
          scheduleRecovery();
          return;
        }

        if (state === 'failed') {
          patch({ phase: 'reconnecting' });
          void restartIce('ice-failed');
        }
      };

      connection.addEventListener('connectionstatechange', () => {
        onState(connection.connectionState);
      });

      // Safari reports `connectionState` late and sometimes not at all, so the
      // older ICE-level state is watched as well. Both funnel into one handler
      // and the transitions are idempotent, so a doubled event costs nothing.
      connection.addEventListener('iceconnectionstatechange', () => {
        onState(connection.iceConnectionState);
      });
    },
    [emit, patch, restartIce, scheduleRecovery],
  );

  // --- Outgoing ------------------------------------------------------------

  const start = React.useCallback(
    async (kind: CallKind): Promise<void> => {
      if (!chatId) return;
      if (session || callIdRef.current) {
        toast.error('You are already in a call');
        return;
      }
      if (socketStatus !== 'connected') {
        toast.error('You need a connection to start a call');
        return;
      }

      let stream: MediaStream;
      try {
        stream = await captureLocalMedia(kind);
      } catch (error) {
        toast.error(describeMediaError(error));
        return;
      }

      try {
        const config = iceConfig ?? (await loadIceConfig());
        const handles = createPeer(config.iceServers, stream, {
          iceTransportPolicy: config.iceTransportPolicy,
        });

        peerRef.current = handles;
        localRef.current = stream;
        cameraRef.current = stream.getVideoTracks()[0] ?? null;
        roleRef.current = 'caller';
        setLocalStream(stream);
        attachPeer(handles);

        // Shown before the invite is acknowledged: the round trip is short, but
        // a button that does nothing visible for even half a second reads as
        // broken, and the call id is not needed to say "Calling…".
        setSession({
          callId: '',
          kind,
          role: 'caller',
          phase: 'dialling',
          connectedAt: null,
          micOn: true,
          cameraOn: kind === 'VIDEO',
          sharingScreen: false,
          stats: EMPTY_STATS,
          recovered: false,
        });

        const offer = await handles.connection.createOffer();
        await handles.connection.setLocalDescription(offer);

        const { callId } = await request('call:invite', {
          chatId,
          kind,
          sdp: fromDescription(offer),
        });

        callIdRef.current = callId;
        flushLocalIce(callId);
        patch({ callId });
      } catch (error) {
        stopStream(stream);
        teardown();
        toast.error(error instanceof Error ? error.message : 'Could not start the call');
      }
    },
    [
      attachPeer,
      chatId,
      flushLocalIce,
      iceConfig,
      loadIceConfig,
      patch,
      request,
      session,
      socketStatus,
      teardown,
    ],
  );

  // --- Incoming ------------------------------------------------------------

  const accept = React.useCallback(async (): Promise<void> => {
    const invite = incoming;
    if (!invite) return;
    setIncoming(null);

    let stream: MediaStream;
    try {
      stream = await captureLocalMedia(invite.kind);
    } catch (error) {
      toast.error(describeMediaError(error));
      emit('call:decline', { callId: invite.callId, reason: 'no-media' });
      return;
    }

    try {
      const config = iceConfig ?? (await loadIceConfig());
      const handles = createPeer(config.iceServers, stream, {
        iceTransportPolicy: config.iceTransportPolicy,
      });

      peerRef.current = handles;
      localRef.current = stream;
      cameraRef.current = stream.getVideoTracks()[0] ?? null;
      callIdRef.current = invite.callId;
      roleRef.current = 'callee';
      setLocalStream(stream);
      attachPeer(handles);

      await handles.connection.setRemoteDescription(toDescription(invite.sdp));
      // Picks up everything the caller trickled while this side was still
      // deciding whether to answer, which is nearly all of their candidates.
      await drainRemoteIce(handles.connection);

      const answer = await handles.connection.createAnswer();
      await handles.connection.setLocalDescription(answer);

      await request('call:answer', {
        callId: invite.callId,
        sdp: fromDescription(answer),
      });

      // Local candidates gathered between construction and this point were
      // queued because the peer had no call id in scope yet; release them now.
      flushLocalIce(invite.callId);

      setSession({
        callId: invite.callId,
        kind: invite.kind,
        role: 'callee',
        phase: 'connecting',
        connectedAt: null,
        micOn: true,
        cameraOn: invite.kind === 'VIDEO',
        sharingScreen: false,
        stats: EMPTY_STATS,
        recovered: false,
      });

      armConnectWatchdog();
    } catch (error) {
      stopStream(stream);
      teardown();
      emit('call:decline', { callId: invite.callId, reason: 'setup-failed' });
      toast.error(error instanceof Error ? error.message : 'Could not join the call');
    }
  }, [
    armConnectWatchdog,
    attachPeer,
    drainRemoteIce,
    emit,
    flushLocalIce,
    iceConfig,
    incoming,
    loadIceConfig,
    request,
    teardown,
  ]);

  const decline = React.useCallback((): void => {
    if (!incoming) return;
    emit('call:decline', { callId: incoming.callId, reason: 'declined' });
    bufferedIce.current.delete(incoming.callId);
    setIncoming(null);
  }, [emit, incoming]);

  // --- Controls ------------------------------------------------------------

  const toggleMic = React.useCallback((): void => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    // Disabling rather than stopping: a stopped track cannot be restarted, and
    // the transceiver would have to be renegotiated to get audio back.
    track.enabled = !track.enabled;
    patch({ micOn: track.enabled });
  }, [patch]);

  /**
   * Turning the camera on mid-call reuses the video transceiver created at
   * setup, so this never renegotiates — it only swaps the track underneath.
   */
  const toggleCamera = React.useCallback(async (): Promise<void> => {
    const handles = peerRef.current;
    const stream = localRef.current;
    if (!handles || !stream || !session) return;

    if (session.sharingScreen) {
      toast.error('Stop sharing your screen first');
      return;
    }

    const existing = cameraRef.current;

    if (existing && existing.readyState === 'live' && session.cameraOn) {
      existing.enabled = false;
      await handles.videoSender.replaceTrack(null);
      patch({ cameraOn: false });
      return;
    }

    try {
      let track = existing && existing.readyState === 'live' ? existing : null;

      if (!track) {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
        track = fresh.getVideoTracks()[0] ?? null;
      }
      if (!track) return;

      track.enabled = true;
      cameraRef.current = track;
      if (!stream.getVideoTracks().includes(track)) stream.addTrack(track);

      await handles.videoSender.replaceTrack(track);
      // A new MediaStream identity is what tells the preview element to re-bind.
      setLocalStream(new MediaStream(stream.getTracks()));
      patch({ cameraOn: true });
    } catch (error) {
      toast.error(describeMediaError(error));
    }
  }, [patch, session]);

  const toggleScreenShare = React.useCallback(async (): Promise<void> => {
    const handles = peerRef.current;
    if (!handles || !session) return;

    if (session.sharingScreen) {
      stopStream(screenRef.current);
      screenRef.current = null;

      const camera = cameraRef.current;
      const restore = camera && camera.readyState === 'live' && session.cameraOn ? camera : null;
      await handles.videoSender.replaceTrack(restore);
      patch({ sharingScreen: false });
      return;
    }

    try {
      const screen = await captureScreen();
      const track = screen.getVideoTracks()[0];
      if (!track) return;

      screenRef.current = screen;
      await handles.videoSender.replaceTrack(track);
      patch({ sharingScreen: true });

      // The browser's own "Stop sharing" bar bypasses this UI entirely, so the
      // track's end event is the only reliable place to put the camera back.
      track.addEventListener('ended', () => {
        screenRef.current = null;
        const camera = cameraRef.current;
        void handles.videoSender.replaceTrack(
          camera && camera.readyState === 'live' ? camera : null,
        );
        patch({ sharingScreen: false });
      });
    } catch (error) {
      // A cancelled picker throws NotAllowedError; that is not a failure.
      if (error instanceof Error && error.name !== 'NotAllowedError') {
        toast.error('Could not share your screen');
      }
    }
  }, [patch, session]);

  // --- Signalling ----------------------------------------------------------

  useSocketEvent('call:incoming', (payload) => {
    if (payload.from === selfId) return;

    // A second invite while one call is up is refused rather than queued; there
    // is nowhere sensible to put it in a two-person conversation.
    if (session || callIdRef.current) {
      emit('call:decline', { callId: payload.callId, reason: 'busy' });
      return;
    }

    setIncoming({
      callId: payload.callId,
      chatId: payload.chatId,
      from: payload.from,
      kind: payload.kind,
      sdp: payload.sdp,
    });

    // Tells the caller the invite actually landed on a device, so "Calling…"
    // becomes "Ringing…" rather than sitting there indistinguishable from a
    // notification that never arrived.
    emit('call:ringing', { callId: payload.callId });
  });

  useSocketEvent('call:ringing', ({ callId }) => {
    if (callIdRef.current !== callId) return;
    setSession((current) =>
      current && current.phase === 'dialling' ? { ...current, phase: 'ringing' } : current,
    );
  });

  useSocketEvent('call:answered', ({ callId, sdp }) => {
    const handles = peerRef.current;
    if (!handles || callIdRef.current !== callId) return;

    void (async () => {
      try {
        await handles.connection.setRemoteDescription(toDescription(sdp));
        await drainRemoteIce(handles.connection);
        patch({ phase: 'connecting' });
        armConnectWatchdog();
      } catch {
        toast.error('Could not connect the call');
        hangUp('sdp-failed');
      }
    })();
  });

  useSocketEvent('call:restart', ({ callId }) => {
    if (callIdRef.current !== callId) return;
    if (roleRef.current !== 'caller') return;
    void restartIce('peer-requested');
  });

  useSocketEvent('call:ice', ({ callId, candidate }) => {
    const init: RTCIceCandidateInit = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      ...(candidate.usernameFragment ? { usernameFragment: candidate.usernameFragment } : {}),
    };

    const handles = peerRef.current;

    // No peer connection yet means this is a call still being offered — the
    // caller trickles its whole candidate set while the callee is reading the
    // invite. Holding them until `accept` builds the connection is the
    // difference between a call that connects and one that never does.
    if (!handles || callIdRef.current !== callId) {
      const bucket = bufferedIce.current.get(callId) ?? [];
      if (bucket.length < MAX_BUFFERED_CANDIDATES) {
        bucket.push(init);
        bufferedIce.current.set(callId, bucket);
      }
      return;
    }

    // Candidates routinely arrive before the answer does; queueing them is what
    // stops the first seconds of a call from being silently one-way.
    if (!handles.connection.remoteDescription) {
      remoteIce.current.push(init);
      return;
    }

    void handles.connection.addIceCandidate(init).catch(() => undefined);
  });

  useSocketEvent('call:renegotiate', ({ callId, sdp }) => {
    const handles = peerRef.current;
    if (!handles || callIdRef.current !== callId) return;

    void (async () => {
      try {
        await handles.connection.setRemoteDescription(toDescription(sdp));
        await drainRemoteIce(handles.connection);

        // An answer completes a restart we initiated; only an offer needs one.
        if (sdp.type !== 'offer') return;

        const answer = await handles.connection.createAnswer();
        await handles.connection.setLocalDescription(answer);
        emit('call:renegotiate', { callId, sdp: fromDescription(answer) });
      } catch {
        toast.error('The call could not be renegotiated');
        hangUp('renegotiation-failed');
      }
    })();
  });

  useSocketEvent('call:declined', ({ callId }) => {
    bufferedIce.current.delete(callId);
    if (incoming?.callId === callId) setIncoming(null);
    if (callIdRef.current !== callId) return;
    toast.info('The call was declined');
    teardown();
  });

  useSocketEvent('call:ended', ({ callId, reason }) => {
    bufferedIce.current.delete(callId);
    if (incoming?.callId === callId) setIncoming(null);
    if (callIdRef.current !== callId) return;

    if (reason === 'no-answer') toast.info('No answer');
    else if (reason === 'unreachable') toast.info('They are not reachable');

    teardown();
  });

  // --- Signalling recovery -------------------------------------------------

  /**
   * Puts a call back together after the socket comes back.
   *
   * Media and signalling are independent paths, so a socket that blinked may
   * well have left a perfectly good call running — in which case the only thing
   * owed is the candidates that could not be sent while it was down. If the
   * media path did die with it, a fresh gathering round is what recovers it.
   */
  React.useEffect(() => {
    if (socketStatus !== 'connected') return;

    const callId = callIdRef.current;
    if (!callId) return;

    flushLocalIce(callId);

    const state = peerRef.current?.connection.connectionState;
    if (state === 'disconnected' || state === 'failed') {
      void restartIce('signalling-restored');
    }
  }, [socketStatus, flushLocalIce, restartIce]);

  // --- Stats and adaptive bitrate ------------------------------------------

  const phase = session?.phase;
  const callId = session?.callId;

  React.useEffect(() => {
    const handles = peerRef.current;
    if (!handles || !callId) return;
    if (phase !== 'connected' && phase !== 'reconnecting') return;

    let cursor: Parameters<typeof sampleStats>[1] = null;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const result = await sampleStats(handles.connection, cursor);
        if (cancelled) return;

        cursor = result.cursor;
        patch({ stats: result.snapshot });

        emit('call:stats', {
          callId,
          stats: {
            ...(result.snapshot.rttMs !== null ? { rttMs: Math.round(result.snapshot.rttMs) } : {}),
            ...(result.snapshot.jitterMs !== null
              ? { jitterMs: Math.round(result.snapshot.jitterMs) }
              : {}),
            packetsLost: result.snapshot.packetsLost,
            bitrateKbps: result.snapshot.bitrateKbps,
          },
        });

        const target = nextBitrate(bitrateRef.current, result.snapshot);
        if (target !== bitrateRef.current) {
          bitrateRef.current = target;
          await applyBitrate(handles.videoSender, target);
        }
      } catch {
        // A closing connection rejects `getStats`; the interval is about to stop.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [callId, emit, patch, phase]);

  return {
    session,
    incoming,
    localStream,
    remoteStream,
    hasTurn: iceConfig?.hasTurn ?? false,
    start,
    accept,
    decline,
    hangUp,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}
