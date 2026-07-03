import RSSParser from 'rss-parser';
import { createHash } from 'crypto';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { listEnabledFeeds, markFetched, updateFeed, provisionalTitle, type RSSFeed } from '../feeds.js';
import type { DigestPost, PostLink } from '../types/index.js';

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
/** Named entities beyond the XML basics — publishers (Daring Fireball,
 *  WordPress exports, email newsletters) routinely use these and they were
 *  rendering as literal `&ndash;` text in the client. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  copy: '©',
  reg: '®',
  trade: '™',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  ntilde: 'ñ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    // Named entities. `&amp;` decodes here too — as the map is applied in a
    // single pass, `&amp;ndash;` correctly yields the literal text "&ndash;"
    // rather than double-decoding into an en dash.
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,30});/g, (m, name: string) =>
      NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Convert HTML-ish content into rough plain text. Used for the inline
 *  preview / short-post inline render. The full HTML stays on the post
 *  (in `metadata.contentHTML`) for the reader view. */
function stripHtml(html: string): string {
  const stripped = html
    // Drop non-content blocks WHOLE — their text is not article text.
    // Email-derived feeds (e.g. Kill the Newsletter) carry full documents
    // whose <style> CSS was surviving tag-stripping and rendering as a wall
    // of selectors in the preview.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    // Source HTML is pretty-printed with hard line-wraps and indentation
    // INSIDE paragraphs; if those raw newlines survive, previews render as
    // narrow ragged columns. Flatten all source whitespace to single spaces
    // FIRST — real line structure is re-introduced from block tags below.
    .replace(/[\s]+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/(blockquote|figure|figcaption|table|tr)>/gi, '\n')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '');

  return decodeHTMLEntities(stripped)
    // Collapse intra-line whitespace runs, trim line edges, cap blank runs.
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
  // Walk every <img>, skipping tracking pixels and layout spacers —
  // email-derived feeds put those FIRST, and using one as the hero
  // rendered a giant blank block above the post body.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const raw = decodeHTMLEntities(srcMatch[1].trim());
    // Reject data: URIs and empty placeholder srcs (some feeds ship
    // tiny transparent SVGs as lazy-load placeholders before the real
    // src is swapped in via data-src).
    if (!raw || raw.startsWith('data:')) continue;
    // Skip 1–2px images (tracking pixels / spacers) by declared size.
    const w = tag.match(/\bwidth\s*=\s*["']?(\d+)/i);
    const h = tag.match(/\bheight\s*=\s*["']?(\d+)/i);
    if ((w && parseInt(w[1], 10) <= 2) || (h && parseInt(h[1], 10) <= 2)) continue;
    // Skip URLs that are clearly beacons/spacers by name.
    if (/(spacer|pixel|beacon|track(?:ing)?|open\.gif|1x1)/i.test(raw)) continue;
    return raw;
  }
  return undefined;
}

/** Stable post id for items without a GUID. We hash the feed URL + the
 *  best identifier we have, falling back to title+date for the very
 *  worst-behaved feeds. */
function deriveId(feed: RSSFeed, item: ParsedItem): string {
  if (item.guid && item.guid.trim()) return item.guid;
  const seed = `${feed.feedUrl}|${item.link || ''}|${item.title || ''}|${item.isoDate || item.pubDate || ''}`;
  return createHash('sha1').update(seed).digest('hex');
}

/**
 * Extract `[Link: Title | Source | https://… | Source]`-style blocks (The
 * Verge's quick-posts embed format) from stripped text. They rendered as an
 * ugly wall of pipes; instead we surface them as proper link cards via the
 * post's `links` array and drop them from the body text.
 */
function extractBracketLinks(text: string): { text: string; links: PostLink[] } {
  const links: PostLink[] = [];
  const cleaned = text.replace(/\[Link:\s*([^\]]+)\]/gi, (whole, inner: string) => {
    const urlMatch = inner.match(/https?:\/\/[^\s|\]]+/);
    if (!urlMatch) return whole; // no URL — leave the text untouched
    const url = urlMatch[0];
    // Title = everything before the first pipe (or before the URL).
    const firstSegment = inner.split('|')[0].trim();
    const title = firstSegment && !firstSegment.startsWith('http') ? firstSegment : undefined;
    // Source name (e.g. "TechCrunch") from a non-URL segment after the title.
    const source = inner
      .split('|')
      .map(s => s.trim())
      .find(s => s && s !== firstSegment && !s.startsWith('http'));
    if (!links.some(l => l.url === url)) {
      links.push({ url, ...(title ? { title } : {}), ...(source ? { description: source } : {}) });
    }
    return '';
  });
  return {
    text: cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim(),
    links,
  };
}

function itemToDigestPost(feed: RSSFeed, raw: ParsedItem): DigestPost {
  const fullHTML = raw.contentEncoded || raw.content || '';
  const strippedBody = stripHtml(fullHTML) || raw.contentSnippet?.trim() || '';
  const { text: textBody, links } = extractBracketLinks(strippedBody);
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
    ...(links.length > 0 ? { links } : {}),
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

      // If this feed was saved with a placeholder title (host name) because the
      // host was too slow to parse at add-time, upgrade it now. The host-equality
      // check means a user-renamed title is never clobbered.
      const parsedTitle = (parsed.title || '').trim();
      if (parsedTitle && feed.title === provisionalTitle(feed.feedUrl)) {
        await updateFeed(feed.id, { title: parsedTitle });
        logger.info(`RSS: upgraded title for ${feed.feedUrl} -> ${parsedTitle}`);
      }

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
