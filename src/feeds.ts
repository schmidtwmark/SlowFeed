import RSSParser from 'rss-parser';
import { query } from './db.js';
import { logger } from './logger.js';

export type ParsedFeed = Awaited<ReturnType<RSSParser['parseURL']>>;

export interface ResolvedFeed {
  /** The actual feed URL that parsed successfully (may differ from input). */
  feedUrl: string;
  parsed: ParsedFeed;
}

const FEED_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Hard cap on any single feed fetch. Without this, a stalled/throttling host
// (kill-the-newsletter.com does this on repeat requests) hangs the request
// until the *client's* 60s timeout fires — surfacing as "request timed out".
const FEED_TIMEOUT_MS = 12000;

// Common feed locations to try when a site URL has no discoverable <link>.
const COMMON_FEED_PATHS = [
  '/feed',
  '/rss',
  '/feed.xml',
  '/rss.xml',
  '/atom.xml',
  '/index.xml',
  '/feed/',
  '/rss/',
  '/feeds/posts/default',
];

/**
 * Resolve a user-supplied URL to a working feed. People paste a site's
 * homepage ("https://sources.news") far more often than a raw feed URL, so we:
 *   1. try the input directly as a feed,
 *   2. fetch the page HTML and follow any `<link rel="alternate">` feed link,
 *   3. fall back to common feed paths (/feed, /rss.xml, …).
 * The first candidate that parses wins. Throws if none do.
 */
export async function resolveFeed(inputUrl: string): Promise<ResolvedFeed> {
  const parser = new RSSParser({
    timeout: FEED_TIMEOUT_MS,
    maxRedirects: 5,
    headers: { 'User-Agent': FEED_UA },
  });

  // 1. Maybe it's already a feed.
  try {
    const parsed = await parser.parseURL(inputUrl);
    return { feedUrl: inputUrl, parsed };
  } catch {
    // Not a direct feed (likely an HTML page) — discover candidates.
  }

  const candidates = await discoverFeedCandidates(inputUrl);
  if (candidates.length === 0) {
    throw new Error('No RSS or Atom feed found at that URL');
  }

  // Probe candidates concurrently and take the first that parses — otherwise a
  // handful of slow 404s serialize into a multi-minute wait.
  try {
    return await Promise.any(
      candidates.map(async (candidate) => {
        const parsed = await parser.parseURL(candidate);
        return { feedUrl: candidate, parsed };
      })
    );
  } catch {
    throw new Error('No RSS or Atom feed found at that URL');
  }
}

/** Does this URL look like a direct feed URL? Lets the caller save it even
 *  when a slow/throttling host blocks parsing at add-time. */
export function looksLikeFeedURL(rawUrl: string): boolean {
  try {
    const path = new URL(rawUrl).pathname.toLowerCase();
    return /\.(xml|rss|atom)$/.test(path) || /(^|\/)(feed|rss|atom)s?(\/|$)/.test(path);
  } catch {
    return false;
  }
}

/** Readable placeholder title from the URL host, used when we save a feed
 *  before we've fetched its real title. `pollRSS` upgrades it on first fetch. */
export function provisionalTitle(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

/**
 * Given a (probably HTML) URL, return an ordered list of candidate feed URLs:
 * declared `<link rel="alternate">` feeds first (most reliable), then common
 * conventional paths.
 */
async function discoverFeedCandidates(inputUrl: string): Promise<string[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    try {
      const abs = new URL(decodeAttr(raw), inputUrl).toString();
      if (!seen.has(abs)) {
        seen.add(abs);
        candidates.push(abs);
      }
    } catch {
      // Ignore unparseable hrefs.
    }
  };

  let html = '';
  try {
    const resp = await fetch(inputUrl, {
      headers: {
        'User-Agent': FEED_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (resp.ok) html = await resp.text();
  } catch (err) {
    logger.warn(`Feed discovery: failed to fetch ${inputUrl}: ${(err as Error).message}`);
  }

  if (html) {
    // `<link rel="alternate" type="application/rss+xml" href="…">` (attribute
    // order varies, so match the whole tag then pull attributes out).
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/\brel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
      if (!/\btype\s*=\s*["'](application\/(rss|atom)\+xml|application\/xml|text\/xml)/i.test(tag))
        continue;
      const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
      push(href ? href[2] ?? href[3] : null);
    }
  }

  // Conventional paths, resolved against the site origin.
  for (const path of COMMON_FEED_PATHS) push(path);

  return candidates;
}

export interface RSSFeedRow {
  id: number;
  feed_url: string;
  title: string;
  site_url: string | null;
  enabled: boolean;
  last_fetched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RSSFeed {
  id: number;
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  enabled: boolean;
  lastFetchedAt: Date | null;
}

function rowToFeed(r: RSSFeedRow): RSSFeed {
  return {
    id: r.id,
    feedUrl: r.feed_url,
    title: r.title,
    siteUrl: r.site_url,
    enabled: r.enabled,
    lastFetchedAt: r.last_fetched_at,
  };
}

export async function listFeeds(): Promise<RSSFeed[]> {
  const { rows } = await query<RSSFeedRow>(
    `SELECT * FROM rss_feeds ORDER BY title ASC`
  );
  return rows.map(rowToFeed);
}

export async function listEnabledFeeds(): Promise<RSSFeed[]> {
  const { rows } = await query<RSSFeedRow>(
    `SELECT * FROM rss_feeds WHERE enabled = TRUE ORDER BY id ASC`
  );
  return rows.map(rowToFeed);
}

/**
 * Insert a feed. Returns the existing row if `feed_url` already exists —
 * makes adding the same URL twice (or re-importing OPML) idempotent.
 */
export async function addFeed(feedUrl: string, title: string, siteUrl?: string): Promise<RSSFeed> {
  const { rows } = await query<RSSFeedRow>(
    `INSERT INTO rss_feeds (feed_url, title, site_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (feed_url) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [feedUrl, title, siteUrl ?? null]
  );
  return rowToFeed(rows[0]);
}

export async function deleteFeed(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM rss_feeds WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateFeed(
  id: number,
  patch: { title?: string; enabled?: boolean }
): Promise<RSSFeed | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.title === 'string') {
    sets.push(`title = $${values.length + 1}`);
    values.push(patch.title);
  }
  if (typeof patch.enabled === 'boolean') {
    sets.push(`enabled = $${values.length + 1}`);
    values.push(patch.enabled);
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await query<RSSFeedRow>(
    `UPDATE rss_feeds SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return rows[0] ? rowToFeed(rows[0]) : null;
}

export async function markFetched(id: number): Promise<void> {
  await query(`UPDATE rss_feeds SET last_fetched_at = NOW() WHERE id = $1`, [id]);
}

// ---- OPML parsing ----

/**
 * Parse an OPML document into a flat list of `{ feedUrl, title, siteUrl }`.
 *
 * OPML stores subscriptions as `<outline>` elements with `xmlUrl`, `title`,
 * `text`, and `htmlUrl` attributes. Folders are nested `<outline>` groups
 * without `xmlUrl`. We flatten them — folders aren't first-class in Slowfeed.
 *
 * The parser is deliberately tolerant: it scans for `xmlUrl=` attributes
 * regardless of nesting, in document order. A real OPML XML parser would be
 * heavier and the structure is so simple that regex is enough here.
 */
export interface ParsedOPMLEntry {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
}

export function parseOPML(xml: string): ParsedOPMLEntry[] {
  const entries: ParsedOPMLEntry[] = [];
  const seen = new Set<string>();

  // Match every `<outline ... />` or `<outline ...>` tag's attributes blob.
  const outlineRe = /<outline\b([^>]*)>/gi;
  for (const m of xml.matchAll(outlineRe)) {
    const attrs = m[1];
    const xmlUrl = pickAttr(attrs, 'xmlUrl') || pickAttr(attrs, 'xmlurl');
    if (!xmlUrl) continue; // folder, no feed

    const title = pickAttr(attrs, 'title') || pickAttr(attrs, 'text') || xmlUrl;
    const htmlUrl = pickAttr(attrs, 'htmlUrl') || pickAttr(attrs, 'htmlurl');

    if (seen.has(xmlUrl)) continue;
    seen.add(xmlUrl);

    entries.push({
      feedUrl: decodeAttr(xmlUrl),
      title: decodeAttr(title),
      siteUrl: htmlUrl ? decodeAttr(htmlUrl) : null,
    });
  }

  return entries;
}

/** Pull `name="value"` (or single-quoted) out of a tag-attributes blob. */
function pickAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = attrs.match(re);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

function decodeAttr(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Add many feeds at once (used by OPML import). Returns counts.
 * Uses ON CONFLICT to make re-importing the same OPML safe.
 */
export async function addFeedsBulk(entries: ParsedOPMLEntry[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const e of entries) {
    try {
      const result = await query<{ id: number }>(
        `INSERT INTO rss_feeds (feed_url, title, site_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (feed_url) DO NOTHING
         RETURNING id`,
        [e.feedUrl, e.title, e.siteUrl]
      );
      if ((result.rowCount ?? 0) > 0) inserted++;
      else skipped++;
    } catch (err) {
      logger.warn(`Failed to import feed ${e.feedUrl}: ${(err as Error).message}`);
      skipped++;
    }
  }
  return { inserted, skipped };
}
