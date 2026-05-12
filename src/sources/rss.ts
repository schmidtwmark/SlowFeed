import RSSParser from 'rss-parser';
import { createHash } from 'crypto';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { listEnabledFeeds, markFetched, type RSSFeed } from '../feeds.js';
import type { DigestPost } from '../types/index.js';

/**
 * Custom-typed parser. We pull a couple of common non-standard fields
 * (content:encoded for full-text, dc:creator for author) so they don't get
 * lost in `rss-parser`'s default mapping.
 */
const parser = new RSSParser<unknown, {
  'content:encoded'?: string;
  'dc:creator'?: string;
  contentEncoded?: string;
  creator?: string;
}>({
  customFields: {
    item: [
      ['content:encoded', 'contentEncoded'],
      ['dc:creator', 'creator'],
    ],
  },
});

interface ParsedItem {
  guid?: string;
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  creator?: string;
  author?: string;
  contentEncoded?: string;
  content?: string;
  contentSnippet?: string;
}

/**
 * Decode the HTML entities publisher feeds typically include — both
 * named (&amp;, &lt;, &nbsp;, …) and numeric (&#8220;, &#x2014;, …).
 * Numeric references (decimal and hex) are common on WordPress sites
 * for curly quotes, em-dashes, and ellipses, and were rendering as
 * literal `&#8220;` text in the client before this helper existed.
 */
function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

/** Convert HTML-ish content into rough plain text. Used for the inline
 *  preview / short-post inline render. The full HTML stays on the post
 *  (in `metadata.contentHTML`) for the reader view. */
function stripHtml(html: string): string {
  const stripped = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '');

  return decodeHTMLEntities(stripped)
    // Publisher HTML is often pretty-printed with deep indentation; once
    // tags are gone those tabs/spaces survive and render as huge
    // indents in the client preview. Collapse runs of intra-line
    // whitespace to a single space, then trim each line, then collapse
    // blank-line runs.
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find the first usable `<img src="...">` URL in a chunk of HTML. RSS
 * posts use this as a header / hero image preview shown above the
 * body in the client digest view.
 */
function extractFirstImageURL(html: string): string | undefined {
  const match = html.match(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i);
  if (!match) return undefined;
  const raw = decodeHTMLEntities(match[1].trim());
  // Reject data: URIs and empty placeholder srcs (some feeds ship
  // tiny transparent SVGs as lazy-load placeholders before the real
  // src is swapped in via data-src).
  if (!raw || raw.startsWith('data:')) return undefined;
  return raw;
}

/** Stable post id for items without a GUID. We hash the feed URL + the
 *  best identifier we have, falling back to title+date for the very
 *  worst-behaved feeds. */
function deriveId(feed: RSSFeed, item: ParsedItem): string {
  if (item.guid && item.guid.trim()) return item.guid;
  const seed = `${feed.feedUrl}|${item.link || ''}|${item.title || ''}|${item.isoDate || item.pubDate || ''}`;
  return createHash('sha1').update(seed).digest('hex');
}

function itemToDigestPost(feed: RSSFeed, raw: ParsedItem): DigestPost {
  const fullHTML = raw.contentEncoded || raw.content || '';
  const textBody = stripHtml(fullHTML) || raw.contentSnippet?.trim() || '';
  const author = decodeHTMLEntities((raw.creator?.trim() || raw.author?.trim() || feed.title));
  const published = raw.isoDate ? new Date(raw.isoDate)
    : raw.pubDate ? new Date(raw.pubDate)
    : new Date();
  const headerImage = extractFirstImageURL(fullHTML);

  return {
    postId: deriveId(feed, raw),
    // Titles often contain numeric entities (curly quotes etc.) that
    // were rendering as literal `&#8220;` in the client.
    title: decodeHTMLEntities(raw.title?.trim() || '(untitled)'),
    content: textBody,
    url: raw.link || feed.siteUrl || feed.feedUrl,
    author,
    publishedAt: published,
    rawJson: raw,
    metadata: {
      // Reuse existing client-side fields. `feedTitle` is new — added to
      // the shared `PostMetadata` type alongside source-specific fields.
      feedTitle: feed.title,
      // Carry the full HTML so the client's reader view can render it
      // without a second network request.
      contentHTML: fullHTML || undefined,
      // First image extracted from the article body; the client uses
      // this as a hero preview above the post body and can render it
      // as a thumbnail or full image based on the user's setting.
      headerImageURL: headerImage,
    },
  };
}

/**
 * Poll every enabled RSS feed. Each feed is fetched independently — one
 * broken feed shouldn't stop the others.
 *
 * Returns the union of new items across feeds. The caller (scheduler) runs
 * the global `seen_posts` dedup, so we don't bother filtering by
 * `last_fetched_at` for correctness — but we do use it to cap how many
 * items we emit on a busy first poll.
 */
export async function pollRSS(): Promise<DigestPost[]> {
  const config = getConfig();
  if (!config.rss_enabled) {
    logger.debug('RSS polling disabled');
    return [];
  }

  const feeds = await listEnabledFeeds();
  if (feeds.length === 0) {
    logger.debug('RSS polling: no enabled feeds');
    return [];
  }

  logger.info(`Polling RSS (${feeds.length} feeds)...`);
  const results: DigestPost[] = [];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.feedUrl);
      const items = (parsed.items ?? []) as ParsedItem[];
      // Cap each feed at 30 items to keep digest size sane on first poll
      // for noisy feeds. The seen_posts table dedupes across runs.
      const capped = items.slice(0, 30);
      for (const raw of capped) {
        results.push(itemToDigestPost(feed, raw));
      }
      await markFetched(feed.id);
      logger.debug(`RSS ${feed.title}: ${capped.length} items`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`RSS feed ${feed.feedUrl} failed: ${msg}`);
      // Continue with other feeds.
    }
  }

  // Reverse-chronological so the digest list reads newest-first.
  results.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  logger.info(`RSS poll complete: ${results.length} items across ${feeds.length} feeds`);
  return results;
}
