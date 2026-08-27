import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageSeenLabel } from '@/features/chat/components/message-status';

/**
 * The "Seen …" line.
 *
 * It is the only place the interface says anything about delivery, and it is
 * deliberately silent until the other person has actually opened the message:
 * an unread message must look no different from one that was never sent, so
 * these tests pin the silence as hard as they pin the text.
 */

const NOW = new Date('2026-07-31T12:00:00.000Z');

function agoMs(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('silence while unread', () => {
  it('renders nothing when there is no read receipt', () => {
    const { container } = render(<MessageSeenLabel readAt={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('never renders a tick, a check, or the word delivered', () => {
    const { container } = render(<MessageSeenLabel readAt={agoMs(0)} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).not.toMatch(/deliver/i);
  });
});

describe('relative wording', () => {
  it('says "just now" under a minute', () => {
    render(<MessageSeenLabel readAt={agoMs(30_000)} />);
    expect(screen.getByText(/Seen just now/)).toBeTruthy();
  });

  it('counts whole minutes within the hour', () => {
    render(<MessageSeenLabel readAt={agoMs(2 * 60_000)} />);
    expect(screen.getByText(/Seen 2m ago/)).toBeTruthy();
  });

  it('counts hours later the same day', () => {
    render(<MessageSeenLabel readAt={agoMs(3 * 3_600_000)} />);
    expect(screen.getByText(/Seen 3h ago/)).toBeTruthy();
  });

  it('says "Yesterday" rather than an hour count once the day rolls over', () => {
    render(<MessageSeenLabel readAt={'2026-07-30T09:00:00.000Z'} />);
    expect(screen.getByText(/Seen Yesterday/)).toBeTruthy();
  });

  it('names the weekday within the past week', () => {
    render(<MessageSeenLabel readAt={'2026-07-28T09:00:00.000Z'} />);
    expect(screen.getByText(/Seen Tuesday/)).toBeTruthy();
  });

  it('falls back to a date beyond a week', () => {
    render(<MessageSeenLabel readAt={'2026-07-01T09:00:00.000Z'} />);
    expect(screen.getByText(/Seen 1 July/)).toBeTruthy();
  });
});

describe('accessibility', () => {
  it('exposes the same wording as an accessible name', () => {
    render(<MessageSeenLabel readAt={agoMs(30_000)} />);
    expect(screen.getByLabelText('Seen just now')).toBeTruthy();
  });

  it('carries the exact timestamp as a title for hover', () => {
    const { container } = render(<MessageSeenLabel readAt={agoMs(30_000)} />);
    expect(container.firstElementChild?.getAttribute('title')).toMatch(/^Seen /);
  });
});

describe('styling hooks', () => {
  it('merges a caller className', () => {
    const { container } = render(<MessageSeenLabel readAt={agoMs(0)} className="ml-1" />);
    expect(container.firstElementChild?.getAttribute('class')).toContain('ml-1');
  });
});
