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

  parts.push(`<article class="post" data-source="reddit" data-url="${escapeHtml(post.url)}">`);

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

  parts.push('</article>');

  return parts.join('\n');
}

/**
 * Render an avatar image tag if URL is available
 */
function renderAvatar(avatarUrl: string | undefined, alt: string): string {
  if (!avatarUrl) return '';
  return `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(alt)}" width="32" height="32" loading="lazy">`;
}

/**
 * Format a Bluesky post for the digest
 * @param indentLevel - nesting level for thread indentation (0 = root)
 */
function formatBlueskyPost(post: DigestPost, indentLevel: number = 0): string {
  const parts: string[] = [];
  const indent = indentLevel > 0 ? `style="margin-left: ${Math.min(indentLevel * 24, 72)}px; padding-left: 12px; border-left: 2px solid var(--border, #2a2a4a);"` : '';

  parts.push(`<div class="thread-post" ${indent}>`);

  // Repost attribution
  if (post.metadata?.repostedBy) {
    parts.push(`<p><small>Reposted by <strong>${escapeHtml(post.metadata.repostedBy)}</strong></small></p>`);
  }

  // Author with avatar
  if (post.author) {
    const handle = post.author.replace('@', '');
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.author);
    parts.push(`<p class="post-author">${avatar}<strong><a href="https://bsky.app/profile/${escapeHtml(handle)}">${escapeHtml(post.author)}</a></strong></p>`);
  }

  // Content
  if (post.content) {
    parts.push(post.content);
  }

  parts.push(`</div>`);

  return parts.join('\n');
}

const MAX_THREAD_ITEMS = 5;

/**
 * Calculate indent levels for posts in a thread based on their reply relationships.
 * Returns a map of postId -> indentLevel
 */
function calculateThreadIndents(posts: DigestPost[]): Map<string, number> {
  const indents = new Map<string, number>();
  const uriToPostId = new Map<string, string>();

  // Build URI -> postId lookup
  for (const post of posts) {
    const raw = post.rawJson as { uri?: string } | undefined;
    if (raw?.uri) {
      uriToPostId.set(raw.uri, post.postId);
    }
  }

  // First pass: assign base indent of 0 to root posts
  for (const post of posts) {
    if (!post.metadata?.parentUri) {
      indents.set(post.postId, 0);
    }
  }

  // Multiple passes to resolve reply chains
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 10) {
    changed = false;
    iterations++;
    for (const post of posts) {
      if (indents.has(post.postId)) continue;

      const parentUri = post.metadata?.parentUri;
      if (parentUri) {
        const parentPostId = uriToPostId.get(parentUri);
        if (parentPostId && indents.has(parentPostId)) {
          indents.set(post.postId, (indents.get(parentPostId) || 0) + 1);
          changed = true;
        }
      }
    }
  }

  // Assign default indent of 0 to any remaining posts
  for (const post of posts) {
    if (!indents.has(post.postId)) {
      indents.set(post.postId, 0);
    }
  }

  return indents;
}

/**
 * Group Bluesky posts into threads and format them.
 * Posts that are replies to each other get grouped under a single thread.
 * Overall order is chronological (oldest first), based on each thread/post's earliest timestamp.
 * Threads are limited to MAX_THREAD_ITEMS with overflow indication.
 */
function formatBlueskyPosts(posts: DigestPost[]): string {
  // Group posts by thread root URI
  // Posts without a rootUri are standalone
  const threads = new Map<string, DigestPost[]>();
  const standalone: DigestPost[] = [];

  for (const post of posts) {
    const rootUri = post.metadata?.rootUri;
    if (rootUri) {
      const existing = threads.get(rootUri) || [];
      existing.push(post);
      threads.set(rootUri, existing);
    } else {
      standalone.push(post);
    }
  }

  // Merge: if a standalone post is the root of a thread, attach it
  const standaloneByUri = new Map<string, DigestPost>();
  for (const post of standalone) {
    const raw = post.rawJson as { uri?: string } | undefined;
    if (raw?.uri) {
      standaloneByUri.set(raw.uri, post);
    }
  }

  const usedStandalone = new Set<string>();

  // Build a list of { earliestTime, formatFn } so we can sort everything chronologically
  interface FormattedGroup {
    earliestTime: number;
    render: () => string;
  }
  const groups: FormattedGroup[] = [];

  // Threads
  for (const [rootUri, threadPosts] of threads) {
    const rootPost = standaloneByUri.get(rootUri);
    const allInThread = rootPost ? [rootPost, ...threadPosts] : threadPosts;
    if (rootPost) usedStandalone.add(rootPost.postId);

    // Sort thread internally (chronological)
    allInThread.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());

    // Calculate indent levels
    const indents = calculateThreadIndents(allInThread);

    groups.push({
      earliestTime: allInThread[0].publishedAt.getTime(),
      render: () => {
        const parts: string[] = [];
        const lastPost = allInThread[allInThread.length - 1];
        const totalCount = allInThread.length;
        const overflow = totalCount > MAX_THREAD_ITEMS;
        const displayPosts = overflow ? allInThread.slice(0, MAX_THREAD_ITEMS) : allInThread;

        parts.push(`<article class="post thread" data-source="bluesky" data-url="${escapeHtml(lastPost.url)}">`);
        if (totalCount > 1) {
          parts.push(`<p><strong>Thread (${totalCount} posts):</strong></p>`);
        }
        for (const post of displayPosts) {
          const indent = indents.get(post.postId) || 0;
          parts.push(formatBlueskyPost(post, indent));
        }
        if (overflow) {
          const remaining = totalCount - MAX_THREAD_ITEMS;
          parts.push(`<p class="thread-overflow"><a href="${escapeHtml(lastPost.url)}">+ ${remaining} more post${remaining === 1 ? '' : 's'} →</a></p>`);
        }
        parts.push(`<p><a href="${escapeHtml(lastPost.url)}">View on Bluesky →</a></p>`);
        parts.push('</article>');
        return parts.join('\n');
      },
    });
  }

  // Remaining standalone posts
  for (const post of standalone) {
    if (usedStandalone.has(post.postId)) continue;
    groups.push({
      earliestTime: post.publishedAt.getTime(),
      render: () => {
        const parts: string[] = [];
        parts.push(`<article class="post" data-source="bluesky" data-url="${escapeHtml(post.url)}">`);
        parts.push(formatBlueskyPost(post, 0));
        parts.push(`<p><a href="${escapeHtml(post.url)}">View on Bluesky →</a></p>`);
        parts.push('</article>');
        return parts.join('\n');
      },
    });
  }

  // Sort all groups oldest-first
  groups.sort((a, b) => a.earliestTime - b.earliestTime);

  return groups.map(g => g.render()).join('\n');
}

/**
 * Format a YouTube post for the digest
 */
function formatYouTubePost(post: DigestPost): string {
  const parts: string[] = [];

  const videoIdMatch = post.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : null;

  parts.push(`<article class="post" data-source="youtube" data-url="${escapeHtml(post.url)}"${videoId ? ` data-video-id="${escapeHtml(videoId)}"` : ''}>`);

  // Channel name with avatar
  if (post.metadata?.channel) {
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.metadata.channel);
    parts.push(`<p class="post-author">${avatar}<small>${escapeHtml(post.metadata.channel)}</small></p>`);
  }

  // Title
  parts.push(`<h3><a href="${escapeHtml(post.url)}">${escapeHtml(post.title)}</a></h3>`);

  // Duration
  if (post.metadata?.duration) {
    parts.push(`<p><small>Duration: ${escapeHtml(post.metadata.duration)}</small></p>`);
  }

  // Embed placeholder - the digest page will render iframes; fallback to thumbnail
  if (videoId) {
    parts.push(`<div class="youtube-embed" data-video-id="${escapeHtml(videoId)}"><a href="${escapeHtml(post.url)}"><img src="https://img.youtube.com/vi/${escapeHtml(videoId)}/hqdefault.jpg" alt="${escapeHtml(post.title)}" width="480"></a></div>`);
  } else if (post.metadata?.thumbnail) {
    parts.push(`<p><a href="${escapeHtml(post.url)}"><img src="${escapeHtml(post.metadata.thumbnail)}" alt="${escapeHtml(post.title)}"></a></p>`);
  }

  // Source link
  parts.push(`<p><a href="${escapeHtml(post.url)}">Watch on YouTube →</a></p>`);
  parts.push('</article>');

  return parts.join('\n');
}

/**
 * Format a single Discord message (without channel header)
 */
function formatDiscordMessage(post: DigestPost): string {
  const parts: string[] = [];

  // Author with avatar
  if (post.author) {
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.author);
    parts.push(`<p class="post-author">${avatar}<strong>${escapeHtml(post.author)}</strong></p>`);
  }

  // Content
  if (post.content) {
    parts.push(post.content);
  }

  // Use discord:// protocol to open in app
  const appUrl = post.url.replace('https://discord.com/', 'discord://discord.com/');
  parts.push(`<p><a href="${escapeHtml(appUrl)}">Open in Discord →</a></p>`);

  return parts.join('\n');
}

/**
 * Build a thread tree from Discord messages using reply references.
 * Returns an array of thread groups, each sorted chronologically.
 * A "thread" is a root message plus all messages that reply to it (directly or transitively).
 */
function groupDiscordThreads(posts: DigestPost[]): DigestPost[][] {
  const byId = new Map<string, DigestPost>();
  for (const post of posts) {
    byId.set(post.postId, post);
  }

  // Find the root of each message's thread by walking up the reply chain
  function findRoot(post: DigestPost): string {
    const visited = new Set<string>();
    let current = post;
    while (current.metadata?.replyToMessageId) {
      if (visited.has(current.postId)) break; // cycle guard
      visited.add(current.postId);
      const parent = byId.get(current.metadata.replyToMessageId);
      if (!parent) break;
      current = parent;
    }
    return current.postId;
  }

  // Group by root
  const threads = new Map<string, DigestPost[]>();
  for (const post of posts) {
    const rootId = findRoot(post);
    if (!threads.has(rootId)) {
      threads.set(rootId, []);
    }
    threads.get(rootId)!.push(post);
  }

  // Sort each thread chronologically, then sort threads by their earliest message
  const result: DigestPost[][] = [];
  for (const thread of threads.values()) {
    thread.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
    result.push(thread);
  }
  result.sort((a, b) => a[0].publishedAt.getTime() - b[0].publishedAt.getTime());

  return result;
}

/**
 * Group Discord posts by channel, then by thread within each channel
 */
function formatDiscordPosts(posts: DigestPost[]): string {
  // Group by guildName + channelName
  const channels = new Map<string, { guildName: string; channelName: string; posts: DigestPost[] }>();

  for (const post of posts) {
    const guildName = post.metadata?.guildName || 'Unknown Server';
    const channelName = post.metadata?.channelName || 'unknown';
    const key = `${guildName}::${channelName}`;

    if (!channels.has(key)) {
      channels.set(key, { guildName, channelName, posts: [] });
    }
    channels.get(key)!.posts.push(post);
  }

  const parts: string[] = [];

  for (const { guildName, channelName, posts: channelPosts } of channels.values()) {
    // Channel header
    parts.push(`<h3>${escapeHtml(guildName)} · #${escapeHtml(channelName)}</h3>`);

    // Group into threads, then format
    const threads = groupDiscordThreads(channelPosts);

    for (const thread of threads) {
      const firstPost = thread[0];
      const lastPost = thread[thread.length - 1];
      const appUrl = firstPost.url.replace('https://discord.com/', 'discord://discord.com/');
      const totalCount = thread.length;
      const overflow = totalCount > MAX_THREAD_ITEMS;
      const displayPosts = overflow ? thread.slice(0, MAX_THREAD_ITEMS) : thread;

      parts.push(`<article class="post${totalCount > 1 ? ' thread' : ''}" data-source="discord" data-url="${escapeHtml(appUrl)}">`);
      if (totalCount > 1) {
        parts.push(`<p><strong>Thread (${totalCount} messages):</strong></p>`);
      }
      for (const post of displayPosts) {
        parts.push(formatDiscordMessage(post));
      }
      if (overflow) {
        const remaining = totalCount - MAX_THREAD_ITEMS;
        const lastAppUrl = lastPost.url.replace('https://discord.com/', 'discord://discord.com/');
        parts.push(`<p class="thread-overflow"><a href="${escapeHtml(lastAppUrl)}">+ ${remaining} more message${remaining === 1 ? '' : 's'} →</a></p>`);
      }
      parts.push('</article>');
    }
  }

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
      return formatDiscordMessage(post);
    default:
      return formatRedditPost(post); // Fallback
  }
}

/**
 * Format a group of posts, using source-specific grouping where applicable
 */
function formatPostGroup(posts: DigestPost[], source: SourceType): string {
  switch (source) {
    case 'bluesky':
      return formatBlueskyPosts(posts);
    case 'discord':
      return formatDiscordPosts(posts);
    default:
      // Default: format each post individually
      return posts.map(post => formatPost(post, source)).join('\n');
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
  scheduleId?: number,
  pollRunId?: number
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
    content += formatPostGroup(notifications, source);
  }

  // Regular posts section
  if (regularPosts.length > 0) {
    if (notifications.length > 0) {
      content += '<h2>Posts</h2>\n';
    }
    content += formatPostGroup(regularPosts, source);
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
    `INSERT INTO digest_items (id, source, schedule_id, poll_run_id, title, content, post_count, post_ids, published_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       content = $6,
       post_count = $7,
       post_ids = $8,
       poll_run_id = $4`,
    [
      digestId,
      source,
      scheduleId ?? null,
      pollRunId ?? null,
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
    poll_run_id: pollRunId ?? null,
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
    SELECT id, source, schedule_id, poll_run_id, title, content, post_count, post_ids, published_at, created_at
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
    poll_run_id: row.poll_run_id,
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
