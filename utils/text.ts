/**
 * Plain-text derivations of a message body.
 *
 * Every function here is pure and dependency-free: they run on the server for
 * every message written, and pulling a markdown parser into that path to answer
 * "does this look like code" would be the wrong trade.
 */

export interface CodeBlockDetection {
  isCode: boolean;
  /** The fence's language tag, when one was given. */
  language: string | null;
}

/** ```ts … ``` — the fence's info string is captured, the body ignored. */
const FENCE = /^\s*```([a-z0-9+#-]*)\s*\n([\s\S]*?)```\s*$/i;

/**
 * Decides whether a body should be stored and rendered as code.
 *
 * A fence is conclusive. Without one the heuristic is deliberately conservative
 * — misclassifying prose as code is far more annoying than the reverse, so it
 * requires several structural signals at once rather than any single one.
 */
export function detectCodeBlock(body: string): CodeBlockDetection {
  const fenced = FENCE.exec(body);
  if (fenced) {
    const tag = fenced[1]?.trim();
    return { isCode: true, language: tag ? tag.toLowerCase() : null };
  }

  const lines = body.split('\n');
  if (lines.length < 2) return { isCode: false, language: null };

  const indented = lines.filter((line) => /^(\s{2,}|\t)/.test(line)).length;
  const terminators = lines.filter((line) => /[;{}]\s*$/.test(line)).length;
  const keywords =
    /\b(function|const|let|var|import|export|class|def|return|if|else|for|while|SELECT|INSERT|UPDATE)\b/.test(
      body,
    );

  const isCode = keywords && (indented >= 2 || terminators >= 2);
  return { isCode, language: null };
}

/**
 * Markdown reduced to the words inside it, for search indexing and previews.
 *
 * Not a parser and not reversible: the output is only ever stored in
 * `bodyText` or shown in a one-line preview, never re-rendered. The original
 * body is kept untouched alongside it.
 */
export function stripMarkdown(value: string): string {
  return (
    value
      // Fenced blocks first — their contents must not be mined for emphasis.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      // Images before links: the image syntax is a superset of the link syntax.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/^\s{0,3}([-*_])\s*(\1\s*){2,}$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Trailing characters that are almost always sentence punctuation rather than
 * part of the address. Balanced parens are handled separately below.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

/**
 * Absolute http(s) URLs in the order they appear, de-duplicated.
 *
 * Only used to decide which links deserve a preview card, so being conservative
 * costs nothing: a missed link renders as plain text, whereas a mangled one
 * would send the preview fetcher at the wrong address.
 */
export function extractUrls(body: string): string[] {
  const found = body.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of found) {
    let candidate = raw.replace(TRAILING_PUNCTUATION, '');

    // A closing paren belongs to the URL only if it opened inside it — which is
    // what keeps Wikipedia links intact while "(see https://x.com)" is not.
    while (
      candidate.endsWith(')') &&
      (candidate.match(/\(/g)?.length ?? 0) < (candidate.match(/\)/g)?.length ?? 0)
    ) {
      candidate = candidate.slice(0, -1);
    }

    if (!candidate || seen.has(candidate)) continue;

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }

    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}
