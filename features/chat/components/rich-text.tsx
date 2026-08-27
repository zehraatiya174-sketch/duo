'use client';

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

interface Mention {
  userId: string;
  offset: number;
  length: number;
}

/**
 * A message body, rendered.
 *
 * `react-markdown` is used rather than `dangerouslySetInnerHTML` with a
 * sanitiser: it never produces raw HTML in the first place, so a message
 * containing `<img onerror=…>` is text, not markup. That is the entire XSS
 * story for user content in this app, and it is why no `rehype-raw` appears
 * below — adding it would undo it.
 */
export function RichText({
  body,
  mentions,
  selfId,
  mine,
}: {
  body: string;
  mentions: Mention[];
  /** Non-empty only for the reader's own id, so self-mentions can stand out. */
  selfId: string;
  mine: boolean;
}): React.JSX.Element {
  // Mentions carry byte offsets into the *raw* body. Applying them after
  // markdown has restructured the text is not possible, so they are highlighted
  // by matching the substring they name rather than by position — imprecise
  // against repeated text, but it cannot corrupt the output.
  const mentionTexts = React.useMemo(() => {
    const texts = new Map<string, string>();
    for (const mention of mentions) {
      const slice = body.slice(mention.offset, mention.offset + mention.length);
      if (slice) texts.set(slice, mention.userId);
    }
    return texts;
  }, [body, mentions]);

  const highlight = React.useCallback(
    (children: React.ReactNode): React.ReactNode => {
      if (mentionTexts.size === 0) return children;

      return React.Children.map(children, (child) => {
        if (typeof child !== 'string') return child;

        const parts: React.ReactNode[] = [];
        let rest = child;
        let key = 0;

        while (rest.length > 0) {
          let earliest = -1;
          let matched = '';

          for (const text of mentionTexts.keys()) {
            const at = rest.indexOf(text);
            if (at !== -1 && (earliest === -1 || at < earliest)) {
              earliest = at;
              matched = text;
            }
          }

          if (earliest === -1) {
            parts.push(rest);
            break;
          }

          if (earliest > 0) parts.push(rest.slice(0, earliest));

          const userId = mentionTexts.get(matched);
          parts.push(
            <mark
              key={`m-${key++}`}
              className={cn(
                'rounded-[0.25rem] bg-current/20 px-0.5 font-medium text-inherit',
                userId === selfId && selfId !== '' && 'bg-current/35',
              )}
            >
              {matched}
            </mark>,
          );

          rest = rest.slice(earliest + matched.length);
        }

        return parts;
      });
    },
    [mentionTexts, selfId],
  );

  return (
    <div
      className={cn(
        'text-sm leading-relaxed break-words whitespace-pre-wrap',
        // Everything inherits the bubble's colour so one component works on
        // both the accent-filled outgoing bubble and the neutral incoming one.
        '[&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80',
        '[&_p]:m-0 [&_p+p]:mt-2',
        '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-current/40 [&_blockquote]:pl-2 [&_blockquote]:opacity-85',
        '[&_code]:rounded-[0.25rem] [&_code]:bg-current/15 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.8125em]',
        '[&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--radius-xs)] [&_pre]:bg-black/25 [&_pre]:p-2.5',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_table]:block [&_table]:overflow-x-auto [&_th]:px-2 [&_th]:text-left [&_td]:px-2',
        mine && 'text-white',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // Every link in a message is third-party by definition.
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          p: ({ children }) => <p>{highlight(children)}</p>,
          li: ({ children }) => <li>{highlight(children)}</li>,
          // Images would fetch from arbitrary hosts on render, leaking the
          // reader's IP to whoever sent the link. Shown as the link instead.
          img: ({ src, alt }) => (
            <a href={typeof src === 'string' ? src : '#'} target="_blank" rel="noopener noreferrer">
              {alt || 'Image'}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
