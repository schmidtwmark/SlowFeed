import { createHash } from 'crypto';
import { query } from './db.js';
import { logger } from './logger.js';
import { generateId, isDuplicate } from './dedup.js';
import { findLinkThumbnails } from './link-preview.js';
import type { DigestPost, DigestItem, SourceType, DigestItemRow, PostLink } from './types/index.js';

/**
 * Generate a unique ID for a digest
 */
function generateDigestId(source: SourceType, timestamp: number): string {
  return `${source}_${timestamp}`;
}

/**
 * Filter posts to only include new ones (not already seen)
 */
export async function filterNewPosts(
  posts: DigestPost[],
  source: SourceType
): Promise<DigestPost[]> {
  const newPosts: DigestPost[] = [];
  for (const post of posts) {
    const alreadySeen = await isDuplicate(source, post.postId);
    if (!alreadySeen) {
      newPosts.push(post);
    }
  }
  return newPosts;
}

/**
 * Create a digest from a collection of posts.
 * Stores structured post data in posts_json.
 */
/**
 * Create a digest containing a single synthetic post that surfaces a
 * polling failure to the user's feed. The user wanted these to show up
 * as posts (not just buried in logs) so they can read the error and
 * fix it themselves.
 */
export async function createErrorDigest(
  source: SourceType,
  errorMessage: string,
  scheduleId?: number,
  pollRunId?: number
): Promise<DigestItem | null> {
  const displayNames: Record<string, string> = {
    reddit: 'Reddit', bluesky: 'Bluesky', youtube: 'YouTube',
    discord: 'Discord', mastodon: 'Mastodon', rss: 'RSS',
  };
  const displayName = displayNames[source] ?? source;
  const errorPost: DigestPost = {
    // Per-source + per-message id so successive identical errors collapse
    // to the same seen_posts row instead of stacking forever.
    postId: `__error__:${source}:${createHash('sha1').update(errorMessage).digest('hex').slice(0, 16)}`,
    title: `⚠️ ${displayName} polling failed`,
    content: errorMessage,
    url: '',
    author: 'Slowfeed',
    publishedAt: new Date(),
    metadata: { isError: true },
  };
  return createDigest(source, [errorPost], scheduleId, pollRunId);
}

/**
 * For each post, find Tenor / Instagram URLs in its `content` and
 * scrape the page's og:image. The matching URLs are added as PostLink
 * entries (with `imageUrl` populated) so the client's existing
 * `LinkCardView` renders a tappable thumbnail card. Idempotent:
 * existing links with the same URL are skipped.
 */
async function enrichWithLinkThumbnails(posts: DigestPost[]): Promise<void> {
  for (const post of posts) {
    const text = post.content ?? '';
    if (!text) continue;
    const existingURLs = new Set((post.links ?? []).map(l => l.url));
    let thumbs;
    try {
      thumbs = await findLinkThumbnails(text);
    } catch {
      continue;
    }
    if (thumbs.length === 0) continue;
    const newLinks: PostLink[] = [];
    for (const t of thumbs) {
      if (existingURLs.has(t.pageUrl)) continue;
      existingURLs.add(t.pageUrl);
      newLinks.push({
        url: t.pageUrl,
        title: t.service === 'tenor' ? 'Tenor' : 'Instagram',
        imageUrl: t.imageUrl,
      });
    }
    if (newLinks.length > 0) {
      post.links = [...(post.links ?? []), ...newLinks];
    }
  }
}

export async function createDigest(
  source: SourceType,
  posts: DigestPost[],
  scheduleId?: number,
  pollRunId?: number
): Promise<DigestItem | null> {
  if (posts.length === 0) {
    logger.debug(`No posts to create digest for ${source}`);
    return null;
  }

  // Best-effort link-preview enrichment for Tenor / Instagram URLs in
  // post bodies. Adds a PostLink with the og:image so the client
  // renders a tappable thumbnail card instead of a bare URL. Failures
  // (network, no og tag, scraper-blocked) are silently skipped.
  await enrichWithLinkThumbnails(posts);

  const timestamp = Date.now();
  const digestId = generateDigestId(source, timestamp);
  const displayNames: Record<string, string> = { reddit: 'Reddit', bluesky: 'Bluesky', youtube: 'YouTube', discord: 'Discord', mastodon: 'Mastodon', rss: 'RSS' };
  const title = `${displayNames[source] || source} Digest: ${posts.length} item${posts.length === 1 ? '' : 's'}`;
  const postIds = posts.map(p => p.postId);

  // Mark all posts as seen and link to digest
  for (const post of posts) {
    const seenId = generateId(source, post.postId);
    await query(
      `INSERT INTO seen_posts (id, source, post_id, title, digest_id, added_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET digest_id = $5`,
      [seenId, source, post.postId, post.title, digestId]
    );
  }

  // Store structured post data (strip rawJson to save space)
  const postsJson: DigestPost[] = posts.map(p => {
    const { rawJson, ...rest } = p;
    return rest;
  });

  const content = '';

  // Serialize posts to JSON, stripping characters that PostgreSQL JSONB rejects:
  // - Null bytes (\u0000)
  // - *Lone* (unpaired) UTF-16 surrogates. We must preserve *paired*
  //   surrogates because that's how JavaScript represents every supplementary
  //   character, including emoji. The previous [\uD800-\uDFFF] blanket
  //   regex stripped both halves of every emoji and turned solo-emoji
  //   Bluesky posts into empty strings (MAR-60).
  const postsJsonStr = JSON.stringify(postsJson)
    .replace(/\u0000/g, '')
    .replace(/\\u0000/g, '')
    // Lone surrogates as raw UTF-16 code units in the stringified output.
    // High (U+D800-U+DBFF) not followed by a low surrogate, and low
    // (U+DC00-U+DFFF) not preceded by a high. Paired surrogates (emoji
    // and other supplementary chars) survive both regexes.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // Lone surrogates as JSON \uD8XX *text escapes* — JSON.stringify
    // emits these for any unpaired surrogate it sees in the input. PG
    // JSONB rejects them as invalid UTF-8 ('invalid input syntax for
    // type json'). Match both high (D8-DB) and low (DC-DF) ranges.
    // Paired surrogates aren't escaped by JSON.stringify — they're
    // emitted as literal characters — so this regex doesn't touch them.
    .replace(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, '');

  try {
    await query(
      `INSERT INTO digest_items (id, source, schedule_id, poll_run_id, title, content, post_count, post_ids, posts_json, published_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         content = $6,
         post_count = $7,
         post_ids = $8,
         posts_json = $9::jsonb,
         poll_run_id = $4`,
      [
        digestId, source, scheduleId ?? null, pollRunId ?? null,
        title, content.replace(/\u0000/g, '').replace(/\\u0000/g, ''), posts.length, postIds,
        postsJsonStr,
      ]
    );
  } catch (err) {
    const jsonSize = postsJsonStr.length;
    const preview = postsJsonStr.substring(0, 500);
    logger.error(`Failed to insert digest ${digestId} for ${source} (${posts.length} posts, JSON size: ${jsonSize} bytes)`);
    logger.error(`JSON preview: ${preview}...`);
    logger.error(`Post IDs: ${postIds.join(', ')}`);
    if (err instanceof Error) {
      logger.error(`Database error: ${err.message}`);
      if (err.stack) logger.error(err.stack);
    }
    throw err;
  }

  logger.info(`Created ${source} digest with ${posts.length} items: ${digestId}`);

  return {
    id: digestId, source,
    schedule_id: scheduleId ?? null,
    poll_run_id: pollRunId ?? null,
    poll_run_name: null,
    title, content,
    post_count: posts.length,
    post_ids: postIds,
    posts_json: postsJson,
    published_at: new Date(),
    created_at: new Date(),
    read_at: null,
    last_read_post_id: null,
  };
}

/**
 * Strip HTML tags and decode entities to get plain text
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Database operations ----

function parsePostsJson(raw: unknown): DigestItem['posts_json'] {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

export async function getDigestItems(source?: SourceType): Promise<DigestItem[]> {
  // LEFT JOIN poll_runs so each digest can surface the schedule_name
  // captured at poll-run time. The sidebar uses this to label groups
  // with the schedule the user picked (e.g. "Morning Brew") instead
  // of a raw timestamp.
  let sql = `
    SELECT d.id, d.source, d.schedule_id, d.poll_run_id, d.title, d.content,
           d.post_count, d.post_ids, d.posts_json, d.published_at, d.created_at,
           d.read_at, d.last_read_post_id, pr.schedule_name AS poll_run_name
    FROM digest_items d
    LEFT JOIN poll_runs pr ON pr.id = d.poll_run_id
  `;
  const params: string[] = [];
  if (source) {
    sql += ' WHERE d.source = $1';
    params.push(source);
  }
  sql += ' ORDER BY d.published_at DESC LIMIT 500';

  const { rows } = await query<DigestItemRow & { poll_run_name: string | null }>(sql, params);
  return rows.map(row => ({
    id: row.id,
    source: row.source as SourceType,
    schedule_id: row.schedule_id,
    poll_run_id: row.poll_run_id,
    poll_run_name: row.poll_run_name ?? null,
    title: row.title,
    content: row.content,
    post_count: row.post_count,
    post_ids: row.post_ids,
    posts_json: parsePostsJson(row.posts_json),
    published_at: row.published_at,
    created_at: row.created_at,
    read_at: row.read_at,
    last_read_post_id: row.last_read_post_id,
  }));
}

export async function getDigestById(id: string): Promise<DigestItem | null> {
  const { rows } = await query<DigestItemRow & { poll_run_name: string | null }>(
    `SELECT d.id, d.source, d.schedule_id, d.poll_run_id, d.title, d.content,
            d.post_count, d.post_ids, d.posts_json, d.published_at, d.created_at,
            d.read_at, d.last_read_post_id, pr.schedule_name AS poll_run_name
     FROM digest_items d
     LEFT JOIN poll_runs pr ON pr.id = d.poll_run_id
     WHERE d.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    source: row.source as SourceType,
    schedule_id: row.schedule_id,
    poll_run_id: row.poll_run_id,
    poll_run_name: row.poll_run_name ?? null,
    title: row.title,
    content: row.content,
    post_count: row.post_count,
    post_ids: row.post_ids,
    posts_json: parsePostsJson(row.posts_json),
    published_at: row.published_at,
    created_at: row.created_at,
    read_at: row.read_at,
    last_read_post_id: row.last_read_post_id,
  };
}

export async function markDigestAsRead(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE digest_items SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateScrollPosition(id: string, postId: string): Promise<boolean> {
  const result = await query(
    `UPDATE digest_items SET last_read_post_id = $2 WHERE id = $1`,
    [id, postId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markDigestAsUnread(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE digest_items SET read_at = NULL WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getDigestPosts(digestId: string): Promise<{
  postId: string;
  source: string;
  title: string | null;
}[]> {
  const { rows } = await query<{ post_id: string; source: string; title: string | null }>(
    `SELECT post_id, source, title FROM seen_posts WHERE digest_id = $1 ORDER BY added_at`,
    [digestId]
  );
  return rows.map(r => ({ postId: r.post_id, source: r.source, title: r.title }));
}

export async function pruneOldDigests(ttlDays: number): Promise<number> {
  const result = await query(
    `DELETE FROM digest_items
     WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [ttlDays]
  );
  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) logger.info(`Pruned ${deletedCount} old digest items`);
  return deletedCount;
}
