/**
 * The WebRTC plumbing, kept out of React.
 *
 * Everything here is about the `RTCPeerConnection` itself: constraints, the
 * two transceivers, bitrate adaptation and the stats read-out. The hook that
 * drives it (`hooks/use-call.ts`) owns signalling and component state, so the
 * two concerns can be reasoned about — and tested — separately.
 */

import type { CallKind } from '@/types/models';

/** Media constraints, tuned for a two-person call rather than a conference. */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280, max: 1920 },
  height: { ideal: 720, max: 1080 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};

/**
 * Bitrate ladder, walked down on loss and back up when the link recovers.
 * The floor is low enough to stay intelligible on a bad mobile connection.
 */
export const BITRATE_LADDER_KBPS = [2500, 1200, 600, 300, 150] as const;

/** Above this loss fraction the encoder steps down a rung. */
const LOSS_DEGRADE = 0.06;
/** Below this — and with a healthy round trip — it may step back up. */
const LOSS_RECOVER = 0.01;
const RTT_DEGRADE_MS = 400;

export interface CallStatsSnapshot {
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number;
  bitrateKbps: number;
  /** Fraction of outbound packets lost since the previous sample, 0–1. */
  lossRatio: number;
  /** The negotiated candidate pair, useful for telling relay from direct. */
  transport: 'relay' | 'direct' | 'unknown';
}

export const EMPTY_STATS: CallStatsSnapshot = {
  rttMs: null,
  jitterMs: null,
  packetsLost: 0,
  bitrateKbps: 0,
  lossRatio: 0,
  transport: 'unknown',
};

/** Asks for exactly what the call needs — a video call still needs audio. */
export async function captureLocalMedia(kind: CallKind): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: AUDIO_CONSTRAINTS,
    video: kind === 'VIDEO' ? VIDEO_CONSTRAINTS : false,
  });
}

export async function captureScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    // Tab audio when the browser offers it; declined silently otherwise.
    audio: false,
  });
}

export interface PeerHandles {
  connection: RTCPeerConnection;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender;
}

export interface PeerOptions {
  /** `relay` forces media through TURN; `all` lets ICE choose. */
  iceTransportPolicy?: 'all' | 'relay';
}

/**
 * Builds the peer connection with both media lines already in place.
 *
 * Both an audio and a video transceiver are added up front, even for a voice
 * call. It costs one unused m-line and buys the thing that matters: turning the
 * camera on, or starting to share a screen, is then a `replaceTrack` rather than
 * a full renegotiation — which is the step most likely to fail mid-call.
 */
export function createPeer(
  iceServers: RTCIceServer[],
  localStream: MediaStream,
  options: PeerOptions = {},
): PeerHandles {
  const connection = new RTCPeerConnection({
    iceServers,
    // Trickle ICE with a pre-warmed pool. Gathering starts at construction
    // rather than at `setLocalDescription`, so by the time the offer exists the
    // host and reflexive candidates are usually already in hand — which is most
    // of the difference between a call that connects in a second and one that
    // takes five.
    iceCandidatePoolSize: 8,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
  });

  const audioTrack = localStream.getAudioTracks()[0] ?? null;
  const videoTrack = localStream.getVideoTracks()[0] ?? null;

  const audioTransceiver = audioTrack
    ? connection.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [localStream] })
    : connection.addTransceiver('audio', { direction: 'sendrecv' });

  const videoTransceiver = videoTrack
    ? connection.addTransceiver(videoTrack, { direction: 'sendrecv', streams: [localStream] })
    : connection.addTransceiver('video', { direction: 'sendrecv' });

  return {
    connection,
    audioSender: audioTransceiver.sender,
    videoSender: videoTransceiver.sender,
  };
}

/** Applies a ceiling to the outbound video encoder. */
export async function applyBitrate(sender: RTCRtpSender, kbps: number): Promise<void> {
  const parameters = sender.getParameters();
  const encodings = parameters.encodings.length > 0 ? parameters.encodings : [{}];
  encodings[0] = { ...encodings[0], maxBitrate: kbps * 1000 };

  try {
    await sender.setParameters({ ...parameters, encodings });
  } catch {
    // Some browsers reject a parameter change while the sender is renegotiating.
    // The next sample retries, and an unchanged ceiling is not a failure state.
  }
}

/**
 * Chooses the next rung of the bitrate ladder.
 *
 * Degrading is immediate and recovery is one rung at a time: a link that just
 * dropped packets is more likely to drop more, and oscillating between rungs
 * looks far worse than sitting one step below the ceiling.
 */
export function nextBitrate(current: number, stats: CallStatsSnapshot): number {
  const index = BITRATE_LADDER_KBPS.indexOf(current as (typeof BITRATE_LADDER_KBPS)[number]);
  const position = index === -1 ? 0 : index;

  const struggling =
    stats.lossRatio > LOSS_DEGRADE || (stats.rttMs !== null && stats.rttMs > RTT_DEGRADE_MS);

  if (struggling) {
    return BITRATE_LADDER_KBPS[Math.min(position + 1, BITRATE_LADDER_KBPS.length - 1)] ?? current;
  }

  const healthy =
    stats.lossRatio < LOSS_RECOVER && (stats.rttMs === null || stats.rttMs < RTT_DEGRADE_MS / 2);

  if (healthy && position > 0) {
    return BITRATE_LADDER_KBPS[position - 1] ?? current;
  }

  return current;
}

interface StatsCursor {
  packetsSent: number;
  packetsLost: number;
  bytesSent: number;
  at: number;
}

/**
 * Minimal views of the stats entries this module reads.
 *
 * `getStats()` returns a heterogeneous map and the DOM lib only ships types for
 * some of its members, so the fields are narrowed here to the handful actually
 * used — everything is optional because a browser may omit any of them.
 */
interface OutboundRtpEntry {
  packetsSent?: number;
  bytesSent?: number;
  isRemote?: boolean;
}

interface RemoteInboundRtpEntry {
  packetsLost?: number;
  jitter?: number;
  roundTripTime?: number;
}

interface CandidatePairEntry {
  state?: string;
  nominated?: boolean;
  currentRoundTripTime?: number;
}

interface LocalCandidateEntry {
  candidateType?: string;
}

/**
 * Reads one stats sample, differenced against the previous one.
 *
 * WebRTC reports cumulative counters, so a raw read says nothing about the last
 * few seconds. The cursor is what turns "12,000 packets lost since the call
 * started" into "the link is bad right now".
 */
export async function sampleStats(
  connection: RTCPeerConnection,
  cursor: StatsCursor | null,
): Promise<{ snapshot: CallStatsSnapshot; cursor: StatsCursor }> {
  const report = await connection.getStats();

  let packetsSent = 0;
  let packetsLost = 0;
  let bytesSent = 0;
  let jitterMs: number | null = null;
  let rttMs: number | null = null;
  let transport: CallStatsSnapshot['transport'] = 'unknown';

  report.forEach((value: RTCStats) => {
    const entry: unknown = value;

    if (value.type === 'outbound-rtp') {
      const outbound = entry as OutboundRtpEntry;
      if (outbound.isRemote === true) return;
      packetsSent += outbound.packetsSent ?? 0;
      bytesSent += outbound.bytesSent ?? 0;
      return;
    }

    if (value.type === 'remote-inbound-rtp') {
      const remote = entry as RemoteInboundRtpEntry;
      packetsLost += Math.max(0, remote.packetsLost ?? 0);
      if (typeof remote.jitter === 'number') jitterMs = remote.jitter * 1000;
      if (typeof remote.roundTripTime === 'number') rttMs = remote.roundTripTime * 1000;
      return;
    }

    if (value.type === 'candidate-pair') {
      const pair = entry as CandidatePairEntry;
      // Only the nominated pair describes the path media is actually taking.
      if (pair.state === 'succeeded' && pair.nominated === true) {
        if (typeof pair.currentRoundTripTime === 'number') {
          rttMs = pair.currentRoundTripTime * 1000;
        }
      }
      return;
    }

    if (value.type === 'local-candidate') {
      const candidate = entry as LocalCandidateEntry;
      if (candidate.candidateType === 'relay') transport = 'relay';
      else if (transport === 'unknown') transport = 'direct';
    }
  });

  const now = Date.now();
  const next: StatsCursor = { packetsSent, packetsLost, bytesSent, at: now };

  if (!cursor) {
    return { snapshot: { ...EMPTY_STATS, rttMs, jitterMs, transport }, cursor: next };
  }

  const elapsedSec = Math.max(0.001, (now - cursor.at) / 1000);
  const deltaPackets = Math.max(0, packetsSent - cursor.packetsSent);
  const deltaLost = Math.max(0, packetsLost - cursor.packetsLost);
  const deltaBytes = Math.max(0, bytesSent - cursor.bytesSent);

  return {
    snapshot: {
      rttMs,
      jitterMs,
      packetsLost: deltaLost,
      bitrateKbps: Math.round((deltaBytes * 8) / elapsedSec / 1000),
      lossRatio: deltaPackets + deltaLost > 0 ? deltaLost / (deltaPackets + deltaLost) : 0,
      transport,
    },
    cursor: next,
  };
}

/** Stops every track, so the camera light actually goes out. */
export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
