import crypto from 'crypto';
import { query } from './db.js';
import { logger } from './logger.js';
import { generateId, isDuplicate } from './dedup.js';
import type { DigestPost, DigestItem, SourceType, DigestItemRow } from './types/index.js';

/**
 * Generate a unique ID for a digest
 */
function generateDigestId(source: SourceType, timestamp: number): string {
  return `${source}_${timestamp}`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a Reddit post for the digest
 */
function formatRedditPost(post: DigestPost): string {
  const parts: string[] = [];

  // Metadata line
  const meta: string[] = [];
  if (post.metadata?.subreddit) meta.push(`<strong>r/${escapeHtml(post.metadata.subreddit)}</strong>`);
  if (post.author) {
    const cleanAuthor = post.author.replace(/^u\//, '');
    meta.push(`<a href="https://reddit.com/user/${escapeHtml(cleanAuthor)}">u/${escapeHtml(cleanAuthor)}</a>`);
  }
  if (post.metadata?.score !== undefined) meta.push(`${post.metadata.score} points`);
  if (post.metadata?.comments !== undefined) meta.push(`${post.metadata.comments} comments`);
  if (meta.length > 0) {
    parts.push(`<p><small>${meta.join(' · ')}</small></p>`);
  }

  // Title as heading with link
  parts.push(`<h3><a href="${escapeHtml(post.url)}">${escapeHtml(post.title.replace(/^r\/\w+:\s*/, ''))}</a></h3>`);

  // Content
  if (post.content) {
    parts.push(post.content);
  }

  // Source link
  parts.push(`<p><a href="${escapeHtml(post.url)}">View on Reddit →</a></p>`);
  parts.push('<hr>');

  return parts.join('\n');
}

/**
 * Format a Bluesky post for the digest
 */
function formatBlueskyPost(post: DigestPost): string {
  const parts: string[] = [];

  // Author
  if (post.author) {
    const handle = post.author.replace('@', '');
    parts.push(`<p><strong><a href="https://bsky.app/profile/${escapeHtml(handle)}">${escapeHtml(post.author)}</a></strong></p>`);
  }

  // Content
  if (post.content) {
    parts.push(post.content);
  }

  // Source link
  parts.push(`<p><a href="${escapeHtml(post.url)}">View on Bluesky →</a></p>`);
  parts.push('<hr>');

  return parts.join('\n');
}

/**
 * Format a YouTube post for the digest
 */
function formatYouTubePost(post: DigestPost): string {
  const parts: string[] = [];

  // Channel name
  if (post.metadata?.channel) {
    parts.push(`<p><small>${escapeHtml(post.metadata.channel)}</small></p>`);
  }

  // Title
  parts.push(`<h3><a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a></h3>`);

  // Duration
  if (post.metadata?.duration) {
    parts.push(`<p><small>Duration: ${escapeHtml(post.metadata.duration)}</small></p>`);
  }

  // Clickable thumbnail image (RSS readers don't support iframes)
  const videoIdMatch = post.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  if (videoId) {
    parts.push(`<p><a href="${escapeHtml(post.url)}"><img src="https://img.youtube.com/vi/${escapeHtml(videoId)}/hqdefault.jpg" alt="${escapeHtml(post.title)}" width="480"></a></p>`);
  } else if (post.metadata?.thumbnail) {
    parts.push(`<p><a href="${escapeHtml(post.url)}"><img src="${escapeHtml(post.metadata.thumbnail)}" alt="${escapeHtml(post.title)}"></a></p>`);
  }

  // Source link
  parts.push(`<p><a href="${escapeHtml(post.url)}">Watch on YouTube →</a></p>`);
  parts.push('<hr>');

  return parts.join('\n');
}

/**
 * Format a Discord post for the digest
 */
function formatDiscordPost(post: DigestPost): string {
  const parts: string[] = [];

  // Server and channel
  const meta: string[] = [];
  if (post.metadata?.guildName) meta.push(`<strong>${escapeHtml(post.metadata.guildName)}</strong>`);
  if (post.metadata?.channelName) meta.push(`#${escapeHtml(post.metadata.channelName)}`);
  if (meta.length > 0) {
    parts.push(`<p><small>${meta.join(' · ')}</small></p>`);
  }

  // Author
  if (post.author) {
    parts.push(`<p><strong>${escapeHtml(post.author)}</strong></p>`);
  }

  // Content
  if (post.content) {
    parts.push(post.content);
  }

  // Source link
  parts.push(`<p><a href="${escapeHtml(post.url)}">View in Discord →</a></p>`);
  parts.push('<hr>');

  return parts.join('\n');
}

/**
 * Format a single post based on its source
 */
function formatPost(post: DigestPost, source: SourceType): string {
  switch (source) {
    case 'reddit':
      return formatRedditPost(post);
    case 'bluesky':
      return formatBlueskyPost(post);
    case 'youtube':
      return formatYouTubePost(post);
    case 'discord':
      return formatDiscordPost(post);
    default:
      return formatRedditPost(post); // Fallback
  }
}

/**
 * Get source display name
 */
function getSourceDisplayName(source: SourceType): string {
  switch (source) {
    case 'reddit':
      return 'Reddit';
    case 'bluesky':
      return 'Bluesky';
    case 'youtube':
      return 'YouTube';
    case 'discord':
      return 'Discord';
    default:
      return source;
  }
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
 * Create a digest from a collection of posts
 */
export async function createDigest(
  source: SourceType,
  posts: DigestPost[],
  scheduleId?: number
): Promise<DigestItem | null> {
  if (posts.length === 0) {
    logger.debug(`No posts to create digest for ${source}`);
    return null;
  }

  const timestamp = Date.now();
  const digestId = generateDigestId(source, timestamp);
  const displayName = getSourceDisplayName(source);

  // Separate notifications from regular posts
  const notifications = posts.filter(p => p.isNotification);
  const regularPosts = posts.filter(p => !p.isNotification);

  // Build digest content using clean semantic HTML (no inline styles)
  let content = '';

  // Summary
  const summaryParts: string[] = [];
  if (regularPosts.length > 0) {
    summaryParts.push(`${regularPosts.length} new post${regularPosts.length === 1 ? '' : 's'}`);
  }
  if (notifications.length > 0) {
    summaryParts.push(`${notifications.length} notification${notifications.length === 1 ? '' : 's'}`);
  }
  content += `<p><em>${summaryParts.join(', ')} from ${displayName}</em></p>\n`;

  // Notifications section (if any)
  if (notifications.length > 0) {
    content += '<h2>Notifications</h2>\n';
    for (const post of notifications) {
      content += formatPost(post, source);
    }
  }

  // Regular posts section
  if (regularPosts.length > 0) {
    if (notifications.length > 0) {
      content += '<h2>Posts</h2>\n';
    }
    for (const post of regularPosts) {
      content += formatPost(post, source);
    }
  }

  // Generate title
  const title = `${displayName} Digest: ${posts.length} item${posts.length === 1 ? '' : 's'}`;

  // Collect post IDs
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

  // Insert the digest item
  await query(
    `INSERT INTO digest_items (id, source, schedule_id, title, content, post_count, post_ids, published_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       content = $5,
       post_count = $6,
       post_ids = $7`,
    [
      digestId,
      source,
      scheduleId ?? null,
      title,
      content,
      posts.length,
      postIds,
    ]
  );

  logger.info(`Created ${source} digest with ${posts.length} items: ${digestId}`);

  return {
    id: digestId,
    source,
    schedule_id: scheduleId ?? null,
    title,
    content,
    post_count: posts.length,
    post_ids: postIds,
    published_at: new Date(),
    created_at: new Date(),
  };
}

/**
 * Get all digest items, optionally filtered by source
 */
export async function getDigestItems(source?: SourceType): Promise<DigestItem[]> {
  let sql = `
    SELECT id, source, schedule_id, title, content, post_count, post_ids, published_at, created_at
    FROM digest_items
  `;
  const params: string[] = [];

  if (source) {
    sql += ' WHERE source = $1';
    params.push(source);
  }

  sql += ' ORDER BY published_at DESC LIMIT 500';

  const { rows } = await query<DigestItemRow>(sql, params);

  return rows.map(row => ({
    id: row.id,
    source: row.source as SourceType,
    schedule_id: row.schedule_id,
    title: row.title,
    content: row.content,
    post_count: row.post_count,
    post_ids: row.post_ids,
    published_at: row.published_at,
    created_at: row.created_at,
  }));
}

/**
 * Prune old digest items
 */
export async function pruneOldDigests(ttlDays: number): Promise<number> {
  const result = await query(
    `DELETE FROM digest_items
     WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [ttlDays]
  );

  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) {
    logger.info(`Pruned ${deletedCount} old digest items`);
  }

  return deletedCount;
}
