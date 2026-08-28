import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Transport fallback on the send path.
 *
 * A large upload saturates the uplink for a minute, the socket's heartbeat
 * cannot get through, and a send issued in that window times out against a
 * connection that is dead but has not noticed yet. The socket still reports
 * itself as connected, so picking a transport once and giving up marks a
 * perfectly sendable message as "Not delivered" — which is exactly what
 * happened to a 34 MB video that had already finished uploading.
 *
 * These tests pin the recovery: HTTP is tried whenever the socket attempt
 * fails, not only when the socket is known to be down.
 */

const socket = {
  status: 'connected' as 'connected' | 'disconnected',
  request: vi.fn(),
};

vi.mock('@/components/providers/socket-provider', () => ({
  useSocket: () => socket,
}));

const post = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: { post: (...args: unknown[]) => post(...args) } }));

const { useMessageSender } = await import('@/hooks/use-message-sender');

const CHAT = 'chat-1';
const SELF = 'user-me';

function delivered(clientId: string, via: string) {
  return {
    id: `server-${via}`,
    clientId,
    chatId: CHAT,
    authorId: SELF,
    type: 'TEXT',
    body: via,
    status: 'SENT',
    createdAt: new Date().toISOString(),
    attachments: [],
    reactions: [],
  };
}

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMessageSender(CHAT, SELF), { wrapper });
}

beforeEach(() => {
  socket.status = 'connected';
  socket.request.mockReset();
  post.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('send transport selection', () => {
  it('uses the socket when it is connected and answering', async () => {
    socket.request.mockImplementation((_event, payload) =>
      Promise.resolve(delivered(payload.clientId, 'socket')),
    );

    const { result } = harness();
    await act(async () => {
      await result.current.send({ type: 'TEXT', body: 'hello' });
    });

    expect(socket.request).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.pending).toEqual([]));
  });

  it('falls back to HTTP when the socket acknowledgement times out', async () => {
    socket.request.mockRejectedValue(new Error('operation has timed out'));
    post.mockImplementation((_path, options) =>
      Promise.resolve(delivered(options.body.clientId, 'http')),
    );

    const { result } = harness();
    await act(async () => {
      await result.current.send({ type: 'TEXT', body: 'hello' });
    });

    expect(socket.request).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toBe('/api/messages');

    // Settled, so no "Not delivered" and nothing left in the outbox.
    await waitFor(() => expect(result.current.pending).toEqual([]));
  });

  it('sends the same clientId over both transports, so a retry cannot duplicate', async () => {
    socket.request.mockRejectedValue(new Error('operation has timed out'));
    post.mockImplementation((_path, options) =>
      Promise.resolve(delivered(options.body.clientId, 'http')),
    );

    const { result } = harness();
    await act(async () => {
      await result.current.send({ type: 'TEXT', body: 'hello' });
    });

    const viaSocket = socket.request.mock.calls[0]![1] as { clientId: string };
    const viaHttp = post.mock.calls[0]![1] as { body: { clientId: string } };
    expect(viaHttp.body.clientId).toBe(viaSocket.clientId);
  });

  it('carries attachment ids through the fallback', async () => {
    socket.request.mockRejectedValue(new Error('operation has timed out'));
    post.mockImplementation((_path, options) =>
      Promise.resolve(delivered(options.body.clientId, 'http')),
    );

    const { result } = harness();
    await act(async () => {
      await result.current.send({
        type: 'VIDEO',
        attachments: [{ id: 'attachment-1' } as never],
      });
    });

    const body = (post.mock.calls[0]![1] as { body: { attachmentIds: string[] } }).body;
    expect(body.attachmentIds).toEqual(['attachment-1']);
  });

  it('skips the socket entirely when it is not connected', async () => {
    socket.status = 'disconnected';
    post.mockImplementation((_path, options) =>
      Promise.resolve(delivered(options.body.clientId, 'http')),
    );

    const { result } = harness();
    await act(async () => {
      await result.current.send({ type: 'TEXT', body: 'hello' });
    });

    expect(socket.request).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledOnce();
  });

  it('only reports a failure once both transports have failed', async () => {
    socket.request.mockRejectedValue(new Error('operation has timed out'));
    post.mockRejectedValue(new Error('network down'));

    const { result } = harness();
    await act(async () => {
      await result.current.send({ type: 'TEXT', body: 'hello' });
    });

    expect(socket.request).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();

    // Left in the outbox so Retry and the reconnect drain can both find it.
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
  });
});
