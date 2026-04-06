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

function getSourceDisplayName(source: SourceType): string {
  switch (source) {
    case 'reddit': return 'Reddit';
    case 'bluesky': return 'Bluesky';
    case 'youtube': return 'YouTube';
    case 'discord': return 'Discord';
    default: return source;
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
 * Create a digest from a collection of posts.
 * Stores structured post data in posts_json.
 * HTML content is generated on-demand at serve time via renderDigestHtml().
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
  const title = `${displayName} Digest: ${posts.length} item${posts.length === 1 ? '' : 's'}`;
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

  // Generate HTML content from structured data (for legacy web UI / RSS)
  const content = renderDigestHtml(postsJson, source);

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
      title, content.replace(/\u0000/g, ''), posts.length, postIds,
      // Stringify manually to strip null bytes that PostgreSQL JSONB rejects
      JSON.stringify(postsJson).replace(/\u0000/g, ''),
    ]
  );

  logger.info(`Created ${source} digest with ${posts.length} items: ${digestId}`);

  return {
    id: digestId, source,
    schedule_id: scheduleId ?? null,
    poll_run_id: pollRunId ?? null,
    title, content,
    post_count: posts.length,
    post_ids: postIds,
    posts_json: postsJson,
    published_at: new Date(),
    created_at: new Date(),
    read_at: null,
  };
}

// ---- HTML Rendering (on-demand from structured data) ----

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

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAvatar(url: string | undefined, alt: string): string {
  if (!url) return '';
  return `<img class="avatar" src="${esc(url)}" alt="${esc(alt)}" width="32" height="32" loading="lazy">`;
}

function renderMedia(post: DigestPost): string {
  if (!post.media || post.media.length === 0) return '';
  const parts: string[] = [];

  const images = post.media.filter(m => m.type === 'image');
  const videos = post.media.filter(m => m.type === 'video');
  const files = post.media.filter(m => m.type === 'file');

  // Image gallery
  if (images.length > 1) {
    const galleryId = `gallery-${post.postId.replace(/[^a-zA-Z0-9]/g, '')}`;
    parts.push(`<div class="image-gallery" data-gallery-id="${galleryId}">`);
    parts.push(`<div class="gallery-container">`);
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      parts.push(`<div class="gallery-slide${i === 0 ? ' active' : ''}" data-index="${i}">`);
      parts.push(`<img src="${esc(img.url)}" alt="${esc(img.alt || '')} (${i + 1}/${images.length})">`);
      parts.push(`</div>`);
    }
    parts.push(`</div>`);
    parts.push(`<div class="gallery-nav">`);
    parts.push(`<button class="gallery-btn prev" data-dir="prev">‹</button>`);
    parts.push(`<span class="gallery-counter">1 / ${images.length}</span>`);
    parts.push(`<button class="gallery-btn next" data-dir="next">›</button>`);
    parts.push(`</div></div>`);
  } else if (images.length === 1) {
    const img = images[0];
    parts.push(`<p><img src="${esc(img.url)}" alt="${esc(img.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`);
  }

  // Videos
  for (const vid of videos) {
    if (vid.url.includes('youtube.com') || vid.url.includes('youtu.be')) {
      const videoIdMatch = vid.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      const videoId = videoIdMatch?.[1] || post.metadata?.videoId;
      if (videoId) {
        parts.push(`<div class="youtube-embed" data-video-id="${esc(videoId)}"><a href="${esc(vid.url)}"><img src="https://img.youtube.com/vi/${esc(videoId)}/hqdefault.jpg" alt="${esc(post.title)}" width="480"></a></div>`);
      }
    } else {
      parts.push(`<div class="reddit-video"><video controls playsinline preload="metadata"${vid.thumbnailUrl ? ` poster="${esc(vid.thumbnailUrl)}"` : ''}>`);
      parts.push(`<source src="${esc(vid.url)}" type="video/mp4"></video></div>`);
    }
  }

  // Files
  for (const file of files) {
    parts.push(`<p><a href="${esc(file.url)}">📎 ${esc(file.filename || 'attachment')}</a></p>`);
  }

  return parts.join('\n');
}

function renderLinks(post: DigestPost): string {
  if (!post.links || post.links.length === 0) return '';
  return post.links.map(link => {
    const parts: string[] = [];
    parts.push(`<div style="border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-top: 12px; background: #f9f9f9;">`);
    if (link.imageUrl) {
      parts.push(`<img src="${esc(link.imageUrl)}" alt="" style="max-width: 100%; border-radius: 4px; margin-bottom: 8px;">`);
    }
    parts.push(`<p style="margin: 0 0 4px 0;"><a href="${esc(link.url)}" style="font-weight: bold; color: #0066cc;">${esc(link.title || link.url)}</a></p>`);
    if (link.description) {
      parts.push(`<p style="margin: 0; font-size: 14px; color: #666;">${esc(link.description)}</p>`);
    }
    parts.push(`</div>`);
    return parts.join('\n');
  }).join('\n');
}

function renderComments(post: DigestPost): string {
  if (!post.comments || post.comments.length === 0) return '';
  const parts: string[] = [];
  parts.push('<h4 style="margin: 16px 0 8px 0; font-size: 14px; color: #666;">Top Comments</h4>');
  for (const c of post.comments) {
    parts.push(`<div style="border-left: 3px solid #ff4500; padding: 8px 12px; margin: 8px 0; background: #fafafa;">`);
    parts.push(`<div style="font-size: 13px; color: #666; margin-bottom: 4px;">`);
    parts.push(`<strong style="color: #0066cc;">u/${esc(c.author)}</strong>`);
    if (c.score !== 0) parts.push(` · ${c.score} points`);
    parts.push(`</div>`);
    parts.push(`<div style="line-height: 1.5;">${esc(c.body)}</div>`);
    parts.push(`</div>`);
  }
  return parts.join('\n');
}

function renderEmbeds(post: DigestPost): string {
  if (!post.embeds || post.embeds.length === 0) return '';
  return post.embeds.map(embed => {
    if (embed.type === 'quote') {
      const parts: string[] = [];
      parts.push(`<blockquote style="margin: 8px 0; padding: 8px 12px; border-left: 3px solid #ccc; background: rgba(128,128,128,0.1); border-radius: 4px;">`);
      const headerParts: string[] = [];
      if (embed.author) {
        const avatar = renderAvatar(embed.authorAvatarUrl, embed.author);
        headerParts.push(`${avatar}<strong>${esc(embed.author)}</strong>`);
      }
      if (embed.provider) {
        headerParts.push(`<span style="font-size: 12px; padding: 1px 6px; background: rgba(128,128,128,0.2); border-radius: 8px; margin-left: 4px;">${esc(embed.provider)}</span>`);
      }
      if (headerParts.length > 0) parts.push(`<p class="post-author">${headerParts.join(' ')}</p>`);
      if (embed.text) parts.push(`<p>${esc(embed.text)}</p>`);
      if (embed.imageUrl) {
        parts.push(`<p><img src="${esc(embed.imageUrl)}" alt="" style="max-width: 100%; border-radius: 4px;"></p>`);
      }
      if (embed.url) {
        parts.push(`<p><a href="${esc(embed.url)}">${esc(embed.title || embed.url)}</a></p>`);
      }
      parts.push(`</blockquote>`);
      return parts.join('\n');
    } else {
      // link_card
      const parts: string[] = [];
      parts.push(`<div style="border-left: 4px solid #5865f2; padding: 8px 12px; margin: 8px 0; background: #f0f0f5; border-radius: 4px;">`);
      if (embed.title) {
        if (embed.url) {
          parts.push(`<p style="margin: 0 0 4px 0;"><a href="${esc(embed.url)}" style="font-weight: bold; color: #5865f2;">${esc(embed.title)}</a></p>`);
        } else {
          parts.push(`<p style="margin: 0 0 4px 0; font-weight: bold;">${esc(embed.title)}</p>`);
        }
      }
      if (embed.description) {
        parts.push(`<p style="margin: 0; font-size: 14px; color: #333;">${esc(embed.description)}</p>`);
      }
      if (embed.imageUrl) {
        parts.push(`<p style="margin: 8px 0 0 0;"><img src="${esc(embed.imageUrl)}" style="max-width: 100%; border-radius: 4px;"></p>`);
      }
      parts.push(`</div>`);
      return parts.join('\n');
    }
  }).join('\n');
}

function renderRedditPost(post: DigestPost): string {
  const parts: string[] = [];
  parts.push(`<article class="post" data-source="reddit" data-url="${esc(post.url)}">`);

  const meta: string[] = [];
  if (post.metadata?.subreddit) meta.push(`<strong>r/${esc(post.metadata.subreddit)}</strong>`);
  if (post.author) {
    const cleanAuthor = post.author.replace(/^u\//, '');
    meta.push(`<a href="https://reddit.com/user/${esc(cleanAuthor)}">u/${esc(cleanAuthor)}</a>`);
  }
  if (post.metadata?.score !== undefined) meta.push(`${post.metadata.score} points`);
  if (post.metadata?.numComments !== undefined) meta.push(`${post.metadata.numComments} comments`);
  if (meta.length > 0) parts.push(`<p><small>${meta.join(' · ')}</small></p>`);

  parts.push(`<h3><a href="${esc(post.url)}">${esc(post.title)}</a></h3>`);

  if (post.content) parts.push(`<p>${esc(post.content)}</p>`);

  parts.push(renderMedia(post));
  parts.push(renderLinks(post));
  parts.push(renderComments(post));
  parts.push('</article>');
  return parts.join('\n');
}

/**
 * Render a single Bluesky post node (author, content, media).
 */
function renderBlueskyPostNode(post: DigestPost, indentLevel: number = 0): string {
  const parts: string[] = [];
  const indent = indentLevel > 0 ? `style="margin-left: ${Math.min(indentLevel * 24, 96)}px; padding-left: 12px; border-left: 2px solid var(--border, #2a2a4a);"` : '';
  parts.push(`<div class="thread-post" ${indent}>`);

  if (post.metadata?.repostedBy) {
    parts.push(`<p><small>Reposted by <strong>${esc(post.metadata.repostedBy)}</strong></small></p>`);
  }
  if (post.author) {
    const handle = post.author.replace('@', '');
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.author);
    parts.push(`<p class="post-author">${avatar}<strong><a href="https://bsky.app/profile/${esc(handle)}">${esc(post.author)}</a></strong></p>`);
  }

  if (post.content) parts.push(`<p>${esc(post.content)}</p>`);

  parts.push(renderMedia(post));
  parts.push(renderLinks(post));

  // Render inline quoted post as a styled blockquote
  if (post.quotedPost) {
    parts.push(renderQuotedPostBlock(post.quotedPost));
  }

  // Render any remaining embeds (link cards, etc.)
  parts.push(renderEmbeds(post));

  parts.push(`</div>`);
  return parts.join('\n');
}

/**
 * Render a quoted post as a blockquote block.
 */
function renderQuotedPostBlock(post: DigestPost): string {
  const parts: string[] = [];
  parts.push(`<blockquote style="margin: 8px 0; padding: 8px 12px; border-left: 3px solid #ccc; background: rgba(128,128,128,0.1); border-radius: 4px;">`);
  if (post.author) {
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.author);
    parts.push(`<p class="post-author">${avatar}<strong>${esc(post.author)}</strong></p>`);
  }
  if (post.content) parts.push(`<p>${esc(post.content)}</p>`);
  parts.push(renderMedia(post));
  if (post.quotedPost) {
    parts.push(renderQuotedPostBlock(post.quotedPost)); // recursive
  }
  if (post.url) {
    parts.push(`<p><a href="${esc(post.url)}">View on Bluesky →</a></p>`);
  }
  parts.push(`</blockquote>`);
  return parts.join('\n');
}

const MAX_THREAD_DEPTH = 6;

/**
 * Recursively render a Bluesky post tree (post + replies).
 */
function renderBlueskyTree(post: DigestPost, depth: number = 0): string {
  if (depth > MAX_THREAD_DEPTH) return '';
  const parts: string[] = [];
  parts.push(renderBlueskyPostNode(post, depth));

  if (post.replies) {
    for (const reply of post.replies) {
      parts.push(renderBlueskyTree(reply, depth + 1));
    }
  }

  return parts.join('\n');
}

/**
 * Render all Bluesky posts. Each post is a self-contained tree.
 */
function renderBlueskyPosts(posts: DigestPost[]): string {
  return posts.map(post => {
    const parts: string[] = [];
    parts.push(`<article class="post" data-source="bluesky" data-url="${esc(post.url)}">`);
    parts.push(renderBlueskyTree(post, 0));
    parts.push(`<p><a href="${esc(post.url)}">View on Bluesky →</a></p>`);
    parts.push('</article>');
    return parts.join('\n');
  }).join('\n');
}

function renderYouTubePost(post: DigestPost): string {
  const parts: string[] = [];
  const videoId = post.metadata?.videoId || post.url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];

  parts.push(`<article class="post" data-source="youtube" data-url="${esc(post.url)}"${videoId ? ` data-video-id="${esc(videoId)}"` : ''}>`);

  if (post.metadata?.channel) {
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.metadata.channel);
    parts.push(`<p class="post-author">${avatar}<small>${esc(post.metadata.channel)}</small></p>`);
  }

  parts.push(`<h3><a href="${esc(post.url)}">${esc(post.title)}</a></h3>`);

  if (post.metadata?.duration) parts.push(`<p><small>Duration: ${esc(post.metadata.duration)}</small></p>`);

  parts.push(renderMedia(post));
  parts.push(`<p><a href="${esc(post.url)}">Watch on YouTube →</a></p>`);
  parts.push('</article>');
  return parts.join('\n');
}

function renderDiscordMessage(post: DigestPost): string {
  const parts: string[] = [];
  if (post.author) {
    const avatar = renderAvatar(post.metadata?.avatarUrl, post.author);
    parts.push(`<p class="post-author">${avatar}<strong>${esc(post.author)}</strong></p>`);
  }
  if (post.content) parts.push(`<p>${esc(post.content)}</p>`);
  parts.push(renderMedia(post));
  parts.push(renderEmbeds(post));

  const appUrl = post.url.replace('https://discord.com/', 'discord://discord.com/');
  parts.push(`<p><a href="${esc(appUrl)}">Open in Discord →</a></p>`);
  return parts.join('\n');
}

const MAX_THREAD_ITEMS = 5;

function groupDiscordThreads(posts: DigestPost[]): DigestPost[][] {
  const byId = new Map<string, DigestPost>();
  for (const post of posts) byId.set(post.postId, post);

  function findRoot(post: DigestPost): string {
    const visited = new Set<string>();
    let current = post;
    while (current.metadata?.replyToMessageId) {
      if (visited.has(current.postId)) break;
      visited.add(current.postId);
      const parent = byId.get(current.metadata.replyToMessageId);
      if (!parent) break;
      current = parent;
    }
    return current.postId;
  }

  const threads = new Map<string, DigestPost[]>();
  for (const post of posts) {
    const rootId = findRoot(post);
    if (!threads.has(rootId)) threads.set(rootId, []);
    threads.get(rootId)!.push(post);
  }

  const result: DigestPost[][] = [];
  for (const thread of threads.values()) {
    thread.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
    result.push(thread);
  }
  result.sort((a, b) => new Date(a[0].publishedAt).getTime() - new Date(b[0].publishedAt).getTime());
  return result;
}

function renderDiscordPosts(posts: DigestPost[]): string {
  const channels = new Map<string, { guildName: string; channelName: string; posts: DigestPost[] }>();

  for (const post of posts) {
    const guildName = post.metadata?.guildName || 'Unknown Server';
    const channelName = post.metadata?.channelName || 'unknown';
    const key = `${guildName}::${channelName}`;
    if (!channels.has(key)) channels.set(key, { guildName, channelName, posts: [] });
    channels.get(key)!.posts.push(post);
  }

  const parts: string[] = [];
  for (const { guildName, channelName, posts: channelPosts } of channels.values()) {
    parts.push(`<h3>${esc(guildName)} · #${esc(channelName)}</h3>`);
    const threads = groupDiscordThreads(channelPosts);

    for (const thread of threads) {
      const firstPost = thread[0];
      const appUrl = firstPost.url.replace('https://discord.com/', 'discord://discord.com/');
      const totalCount = thread.length;
      const overflow = totalCount > MAX_THREAD_ITEMS;
      const displayPosts = overflow ? thread.slice(0, MAX_THREAD_ITEMS) : thread;

      parts.push(`<article class="post${totalCount > 1 ? ' thread' : ''}" data-source="discord" data-url="${esc(appUrl)}">`);
      if (totalCount > 1) parts.push(`<p><strong>Thread (${totalCount} messages):</strong></p>`);
      for (const p of displayPosts) parts.push(renderDiscordMessage(p));
      if (overflow) {
        const remaining = totalCount - MAX_THREAD_ITEMS;
        const lastPost = thread[thread.length - 1];
        const lastAppUrl = lastPost.url.replace('https://discord.com/', 'discord://discord.com/');
        parts.push(`<p class="thread-overflow"><a href="${esc(lastAppUrl)}">+ ${remaining} more message${remaining === 1 ? '' : 's'} →</a></p>`);
      }
      parts.push('</article>');
    }
  }
  return parts.join('\n');
}

/**
 * Render HTML from structured post data.
 * Used by web UI routes and RSS feed generation.
 */
export function renderDigestHtml(posts: DigestPost[], source: SourceType): string {
  const displayName = getSourceDisplayName(source);
  const notifications = posts.filter(p => p.isNotification);
  const regularPosts = posts.filter(p => !p.isNotification);

  let html = '';

  const summaryParts: string[] = [];
  if (regularPosts.length > 0) summaryParts.push(`${regularPosts.length} new post${regularPosts.length === 1 ? '' : 's'}`);
  if (notifications.length > 0) summaryParts.push(`${notifications.length} notification${notifications.length === 1 ? '' : 's'}`);
  html += `<p><em>${summaryParts.join(', ')} from ${displayName}</em></p>\n`;

  if (notifications.length > 0) {
    html += '<h2>Notifications</h2>\n';
    html += renderPostGroup(notifications, source);
  }

  if (regularPosts.length > 0) {
    if (notifications.length > 0) html += '<h2>Posts</h2>\n';
    html += renderPostGroup(regularPosts, source);
  }

  return html;
}

function renderPostGroup(posts: DigestPost[], source: SourceType): string {
  switch (source) {
    case 'bluesky': return renderBlueskyPosts(posts);
    case 'discord': return renderDiscordPosts(posts);
    default: return posts.map(p => renderSinglePost(p, source)).join('\n');
  }
}

function renderSinglePost(post: DigestPost, source: SourceType): string {
  switch (source) {
    case 'reddit': return renderRedditPost(post);
    case 'youtube': return renderYouTubePost(post);
    case 'discord': return renderDiscordMessage(post);
    case 'bluesky': return renderBlueskyPostNode(post);
    default: return renderRedditPost(post);
  }
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
  let sql = `
    SELECT id, source, schedule_id, poll_run_id, title, content, post_count, post_ids, posts_json, published_at, created_at, read_at
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
    posts_json: parsePostsJson(row.posts_json),
    published_at: row.published_at,
    created_at: row.created_at,
    read_at: row.read_at,
  }));
}

export async function getDigestById(id: string): Promise<DigestItem | null> {
  const { rows } = await query<DigestItemRow>(
    `SELECT id, source, schedule_id, poll_run_id, title, content, post_count, post_ids, posts_json, published_at, created_at, read_at
     FROM digest_items WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    source: row.source as SourceType,
    schedule_id: row.schedule_id,
    poll_run_id: row.poll_run_id,
    title: row.title,
    content: row.content,
    post_count: row.post_count,
    post_ids: row.post_ids,
    posts_json: parsePostsJson(row.posts_json),
    published_at: row.published_at,
    created_at: row.created_at,
    read_at: row.read_at,
  };
}

export async function markDigestAsRead(id: string): Promise<boolean> {
  const result = await query(
    `UPDATE digest_items SET read_at = NOW() WHERE id = $1 AND read_at IS NULL`,
    [id]
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
