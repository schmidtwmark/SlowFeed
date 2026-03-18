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
  let html = `<div style="border: 1px solid #ccc; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #fafafa;">`;

  // Header with subreddit and author
  const subreddit = post.metadata?.subreddit ? `r/${post.metadata.subreddit}` : '';
  const author = post.author || '';
  html += `<div style="margin-bottom: 8px; font-size: 14px; color: #666;">`;
  if (subreddit) {
    html += `<strong>${escapeHtml(subreddit)}</strong>`;
  }
  if (author) {
    html += ` • <a href="https://reddit.com/user/${escapeHtml(author.replace('u/', ''))}" style="color: #0066cc;">${escapeHtml(author)}</a>`;
  }
  if (post.metadata?.score !== undefined) {
    html += ` • ${post.metadata.score} points`;
  }
  if (post.metadata?.comments !== undefined) {
    html += ` • ${post.metadata.comments} comments`;
  }
  html += `</div>`;

  // Title
  html += `<h3 style="margin: 0 0 12px 0; font-size: 18px;"><a href="${escapeHtml(post.url)}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(post.title.replace(/^r\/\w+:\s*/, ''))}</a></h3>`;

  // Full content (no truncation)
  if (post.content) {
    html += `<div style="line-height: 1.6;">${post.content}</div>`;
  }

  // View on Reddit link
  html += `<div style="margin-top: 12px;"><a href="${escapeHtml(post.url)}" style="color: #0066cc; font-size: 14px;">View on Reddit →</a></div>`;

  html += '</div>';
  return html;
}

/**
 * Format a Bluesky post for the digest
 */
function formatBlueskyPost(post: DigestPost): string {
  let html = `<div style="border: 1px solid #ccc; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #fafafa;">`;

  // Author header with link
  if (post.author) {
    const handle = post.author.replace('@', '');
    html += `<div style="margin-bottom: 12px;">`;
    html += `<a href="https://bsky.app/profile/${escapeHtml(handle)}" style="color: #0066cc; font-weight: bold; text-decoration: none;">${escapeHtml(post.author)}</a>`;
    html += `</div>`;
  }

  // Post content (text, images, embeds)
  if (post.content) {
    html += `<div style="line-height: 1.6; margin-bottom: 12px;">${post.content}</div>`;
  }

  // View on Bluesky link
  html += `<div style="margin-top: 8px;"><a href="${escapeHtml(post.url)}" style="color: #0066cc; font-size: 14px;">View on Bluesky →</a></div>`;

  html += '</div>';
  return html;
}

/**
 * Format a YouTube post for the digest
 */
function formatYouTubePost(post: DigestPost): string {
  let html = `<div style="border: 1px solid #ccc; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #fafafa;">`;

  // Channel name
  if (post.metadata?.channel) {
    html += `<div style="margin-bottom: 8px; font-weight: bold; color: #333;">${escapeHtml(post.metadata.channel)}</div>`;
  }

  // Title
  html += `<h3 style="margin: 0 0 12px 0; font-size: 18px;"><a href="${escapeHtml(post.url)}" style="color: #1a1a1a; text-decoration: none;">${escapeHtml(post.title)}</a></h3>`;

  // Duration if available
  if (post.metadata?.duration) {
    html += `<div style="margin-bottom: 12px; font-size: 14px; color: #666;">Duration: ${escapeHtml(post.metadata.duration)}</div>`;
  }

  // Video embed - extract video ID from URL
  const videoIdMatch = post.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : post.postId;

  if (videoId) {
    html += `<div style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; margin-bottom: 12px;">`;
    html += `<iframe src="https://www.youtube.com/embed/${escapeHtml(videoId)}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0;" allowfullscreen></iframe>`;
    html += `</div>`;
  } else if (post.metadata?.thumbnail) {
    // Fallback to thumbnail if we can't get video ID
    html += `<p><a href="${escapeHtml(post.url)}"><img src="${escapeHtml(post.metadata.thumbnail)}" alt="Thumbnail" style="max-width: 100%; border-radius: 4px;"></a></p>`;
  }

  // Watch on YouTube link
  html += `<div><a href="${escapeHtml(post.url)}" style="color: #cc0000; font-size: 14px;">Watch on YouTube →</a></div>`;

  html += '</div>';
  return html;
}

/**
 * Format a Discord post for the digest
 */
function formatDiscordPost(post: DigestPost): string {
  let html = `<div style="border: 1px solid #5865f2; border-left-width: 4px; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #fafafa;">`;

  // Server and channel header
  const serverName = post.metadata?.guildName || '';
  const channelName = post.metadata?.channelName || '';
  html += `<div style="margin-bottom: 8px; font-size: 14px; color: #666;">`;
  if (serverName) {
    html += `<strong>${escapeHtml(serverName)}</strong>`;
  }
  if (channelName) {
    html += ` • <span style="color: #5865f2;">#${escapeHtml(channelName)}</span>`;
  }
  html += `</div>`;

  // Author
  if (post.author) {
    html += `<div style="margin-bottom: 8px; font-weight: bold; color: #333;">${escapeHtml(post.author)}</div>`;
  }

  // Message content
  if (post.content) {
    html += `<div style="line-height: 1.6; margin-bottom: 12px;">${post.content}</div>`;
  }

  // View in Discord link
  html += `<div><a href="${escapeHtml(post.url)}" style="color: #5865f2; font-size: 14px;">View in Discord →</a></div>`;

  html += '</div>';
  return html;
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

  // Build digest content
  let content = '<div class="digest">';

  // Summary
  const summaryParts: string[] = [];
  if (regularPosts.length > 0) {
    summaryParts.push(`${regularPosts.length} new post${regularPosts.length === 1 ? '' : 's'}`);
  }
  if (notifications.length > 0) {
    summaryParts.push(`${notifications.length} notification${notifications.length === 1 ? '' : 's'}`);
  }
  content += `<p class="digest-summary">${summaryParts.join(', ')} from ${displayName}</p>`;

  // Notifications section (if any)
  if (notifications.length > 0) {
    content += '<div class="digest-section notifications">';
    content += '<h2>Notifications</h2>';
    for (const post of notifications) {
      content += formatPost(post, source);
    }
    content += '</div>';
  }

  // Regular posts section
  if (regularPosts.length > 0) {
    content += '<div class="digest-section posts">';
    if (notifications.length > 0) {
      content += '<h2>Posts</h2>';
    }
    for (const post of regularPosts) {
      content += formatPost(post, source);
    }
    content += '</div>';
  }

  content += '</div>';

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
