import { render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALICE, BOB, messageDto } from '@/tests/helpers/factories';
import type { MessageDTO } from '@/types/models';

/**
 * Visibility reporting in the timeline.
 *
 * This is the first link in the read-receipt chain: nothing downstream — the
 * receipt row, the socket fan-out, the sender's "Seen …" line — can happen if
 * the timeline never notices that a message reached the screen. The chain is
 * also entirely silent when it breaks, which is how it stayed broken: the
 * reader sees the conversation perfectly either way.
 *
 * So these tests are about *when* the observer exists, not about what it does.
 */

// The virtualizer measures against real layout, which jsdom does not do; it
// would report a zero-height viewport and render no rows at all. Standing in a
// pass-through keeps every row mounted so the wiring under test is reachable.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getTotalSize: () => options.count * 76,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: options.getItemKey(index),
        start: index * 76,
        size: 76,
      })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

// The bubble drags in preferences, media and motion; none of it decides which
// rows get observed.
vi.mock('@/features/chat/components/message-bubble', () => ({
  MessageBubble: ({ message }: { message: MessageDTO }) => <div>{message.body}</div>,
}));

const { MessageList } = await import('@/features/chat/components/message-list');

/** Records what was handed to it and can replay it as an intersection. */
class RecordingObserver {
  static instances: RecordingObserver[] = [];
  readonly observed = new Set<Element>();
  readonly root: Element | null;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = (options?.root as Element | null) ?? null;
    RecordingObserver.instances.push(this);
  }

  observe(node: Element): void {
    this.observed.add(node);
  }
  unobserve(node: Element): void {
    this.observed.delete(node);
  }
  disconnect(): void {
    this.observed.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Fires as though everything currently watched had scrolled into view. */
  fire(): void {
    const entries = [...this.observed].map(
      (target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const original = globalThis.IntersectionObserver;

beforeEach(() => {
  RecordingObserver.instances = [];
  globalThis.IntersectionObserver = RecordingObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  globalThis.IntersectionObserver = original;
});

/** The one live observer — the timeline disconnects any it replaces. */
function currentObserver(): RecordingObserver {
  const observer = RecordingObserver.instances.at(-1);
  if (!observer) throw new Error('The timeline never created an IntersectionObserver');
  return observer;
}

const incoming = [
  messageDto({ id: 'msg_00000000000000000001', authorId: BOB, body: 'first' }),
  messageDto({ id: 'msg_00000000000000000002', authorId: BOB, body: 'second' }),
];

function renderList(props: { loading: boolean; messages: MessageDTO[]; onVisible: () => void }) {
  return (
    <MessageList
      messages={props.messages}
      selfId={ALICE}
      participants={[]}
      peer={null}
      unreadCount={0}
      loading={props.loading}
      loadingOlder={false}
      hasOlder={false}
      loadOlder={() => {}}
      peerTyping={false}
      highlightedId={null}
      editingId={null}
      buildHandlers={() => ({}) as never}
      onEditSubmit={() => {}}
      onEditCancel={() => {}}
      onJump={() => {}}
      onOpenEphemeral={() => Promise.reject(new Error('not used'))}
      onRetry={() => {}}
      onDiscard={() => {}}
      onVisible={props.onVisible}
      registerScroller={() => {}}
    />
  );
}

describe('a conversation opened from cold', () => {
  it('still watches for visibility once the messages arrive', () => {
    const onVisible = vi.fn();

    // A first paint always lands in the loading state, where there is no scroll
    // container yet — the case that used to leave the observer unbuilt for the
    // rest of the session.
    const view = render(renderList({ loading: true, messages: [], onVisible }));
    view.rerender(renderList({ loading: false, messages: incoming, onVisible }));

    currentObserver().fire();

    expect(onVisible.mock.calls.map(([id]) => id)).toEqual([
      'msg_00000000000000000001',
      'msg_00000000000000000002',
    ]);
  });

  it('picks up rows that mounted in the same commit as the container', () => {
    const onVisible = vi.fn();
    const view = render(renderList({ loading: true, messages: [], onVisible }));
    view.rerender(renderList({ loading: false, messages: incoming, onVisible }));

    // Those rows were handed to the row ref before the effect ran, so only the
    // sweep at attach time can have collected them.
    expect(currentObserver().observed.size).toBe(2);
  });

  it('scopes the observer to the scroll container', () => {
    const onVisible = vi.fn();
    const view = render(renderList({ loading: true, messages: [], onVisible }));
    view.rerender(renderList({ loading: false, messages: incoming, onVisible }));

    expect(currentObserver().root).toBe(view.container.querySelector('[role="log"]'));
  });
});

describe('a conversation already on screen', () => {
  it('watches a message that arrives later', () => {
    const onVisible = vi.fn();
    const view = render(renderList({ loading: false, messages: incoming, onVisible }));

    const later = messageDto({ id: 'msg_00000000000000000003', authorId: BOB, body: 'third' });
    view.rerender(renderList({ loading: false, messages: [...incoming, later], onVisible }));

    currentObserver().fire();

    expect(onVisible).toHaveBeenCalledWith('msg_00000000000000000003');
  });

  it('reports nothing for a row that never intersects', () => {
    const onVisible = vi.fn();
    render(renderList({ loading: false, messages: incoming, onVisible }));

    expect(onVisible).not.toHaveBeenCalled();
  });
});
