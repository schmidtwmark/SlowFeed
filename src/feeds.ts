import { query } from './db.js';
import { logger } from './logger.js';

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
