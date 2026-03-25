import { BskyAgent, AppBskyFeedDefs, AppBskyEmbedImages, AppBskyEmbedExternal, AppBskyEmbedRecord, AppBskyEmbedRecordWithMedia } from '@atproto/api';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

let agent: BskyAgent | null = null;
let lastLoginTime: number = 0;
const SESSION_DURATION = 60 * 60 * 1000; // 1 hour

async function getAgent(): Promise<BskyAgent | null> {
  const config = getConfig();

  if (!config.bluesky_handle || !config.bluesky_app_password) {
    return null;
  }

  // Reuse agent if session is still valid
  if (agent && Date.now() - lastLoginTime < SESSION_DURATION) {
    return agent;
  }

  try {
    agent = new BskyAgent({ service: 'https://bsky.social' });

    await agent.login({
      identifier: config.bluesky_handle,
      password: config.bluesky_app_password,
    });

    lastLoginTime = Date.now();
    logger.info(`Bluesky logged in as ${config.bluesky_handle}`);

    return agent;
  } catch (err) {
    logger.error('Bluesky login failed:', err);
    agent = null;
    return null;
  }
}

/**
 * Render a quoted post as a blockquote card
 */
function renderQuotedPost(quotedPost: AppBskyFeedDefs.PostView): string {
  let html = `<blockquote class="quote-post" style="border-left: 3px solid #0085ff; margin: 12px 0; padding: 8px 12px; background: rgba(0, 133, 255, 0.08); border-radius: 0 8px 8px 0;">`;

  // Author line with avatar
  const avatarHtml = quotedPost.author.avatar
    ? `<img src="${escapeHtml(quotedPost.author.avatar)}" alt="" width="20" height="20" style="border-radius: 50%; vertical-align: middle; margin-right: 4px;">`
    : '';
  html += `<p style="margin: 0 0 6px 0;">${avatarHtml}<a href="https://bsky.app/profile/${escapeHtml(quotedPost.author.handle)}" style="font-weight: bold; color: #0085ff;">@${escapeHtml(quotedPost.author.handle)}</a></p>`;

  // Post text
  const quotedRecord = quotedPost.record as { text?: string };
  if (quotedRecord.text) {
    html += `<p style="margin: 0 0 6px 0;">${escapeHtml(quotedRecord.text)}</p>`;
  }

  // Images in the quoted post
  const quotedEmbed = quotedPost.embed;
  if (quotedEmbed && AppBskyEmbedImages.isView(quotedEmbed)) {
    for (const image of quotedEmbed.images) {
      const imageUrl = image.fullsize || image.thumb;
      html += `<p style="margin: 4px 0;"><img src="${imageUrl}" alt="${escapeHtml(image.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`;
    }
  }

  // External link in quoted post
  if (quotedEmbed && AppBskyEmbedExternal.isView(quotedEmbed)) {
    const ext = quotedEmbed.external;
    if (ext.thumb) {
      html += `<p style="margin: 4px 0;"><img src="${ext.thumb}" alt="" style="max-width: 100%; border-radius: 4px;"></p>`;
    }
    html += `<p style="margin: 4px 0;"><a href="${escapeHtml(ext.uri)}" style="color: #0085ff;">${escapeHtml(ext.title || ext.uri)}</a></p>`;
  }

  html += `</blockquote>`;
  return html;
}

/**
 * Extract quoted post info from an embed (if any)
 * Returns the quoted PostView or null if not a quote post
 */
function extractQuotedPost(embed: AppBskyFeedDefs.PostView['embed']): AppBskyFeedDefs.PostView | null {
  if (!embed) return null;

  // Direct quote post
  if (AppBskyEmbedRecord.isView(embed)) {
    const recordEmbed = embed.record;
    if (AppBskyEmbedRecord.isViewRecord(recordEmbed)) {
      return {
        uri: recordEmbed.uri,
        cid: recordEmbed.cid,
        author: recordEmbed.author,
        record: recordEmbed.value,
        embed: recordEmbed.embeds?.[0],
        indexedAt: recordEmbed.indexedAt,
      };
    }
  }

  // Quote with media
  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    const recordEmbed = embed.record.record;
    if (AppBskyEmbedRecord.isViewRecord(recordEmbed)) {
      return {
        uri: recordEmbed.uri,
        cid: recordEmbed.cid,
        author: recordEmbed.author,
        record: recordEmbed.value,
        embed: recordEmbed.embeds?.[0],
        indexedAt: recordEmbed.indexedAt,
      };
    }
  }

  return null;
}

/**
 * Extract post content for display
 * @param skipQuoteInline - if true, don't render quote posts inline (they'll be shown as separate thread posts)
 */
function extractPostContent(post: AppBskyFeedDefs.PostView, skipQuoteInline: boolean = false): string {
  let content = '';
  const record = post.record as { text?: string };

  // Add post text
  if (record.text) {
    content += `<p>${escapeHtml(record.text)}</p>`;
  }

  // Handle embeds
  const embed = post.embed;

  if (embed) {
    // Images - use fullsize for better quality, create gallery if multiple
    if (AppBskyEmbedImages.isView(embed)) {
      if (embed.images.length > 1) {
        // Multiple images - create gallery
        const galleryId = `bsky-gallery-${post.cid.slice(0, 8)}`;
        content += `<div class="image-gallery" data-gallery-id="${galleryId}">`;
        content += `<div class="gallery-container">`;
        for (let i = 0; i < embed.images.length; i++) {
          const image = embed.images[i];
          const imageUrl = image.fullsize || image.thumb;
          content += `<div class="gallery-slide${i === 0 ? ' active' : ''}" data-index="${i}">`;
          content += `<img src="${imageUrl}" alt="${escapeHtml(image.alt || '')} (${i + 1}/${embed.images.length})" loading="lazy">`;
          content += `</div>`;
        }
        content += `</div>`;
        content += `<div class="gallery-nav">`;
        content += `<button class="gallery-btn prev" data-dir="prev">‹</button>`;
        content += `<span class="gallery-counter">1 / ${embed.images.length}</span>`;
        content += `<button class="gallery-btn next" data-dir="next">›</button>`;
        content += `</div>`;
        content += `</div>`;
      } else {
        // Single image
        for (const image of embed.images) {
          const imageUrl = image.fullsize || image.thumb;
          content += `<p><img src="${imageUrl}" alt="${escapeHtml(image.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`;
        }
      }
    }

    // External links - styled card
    if (AppBskyEmbedExternal.isView(embed)) {
      const ext = embed.external;
      content += `<div style="border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-top: 12px; background: #f9f9f9;">`;
      if (ext.thumb) {
        content += `<img src="${ext.thumb}" alt="" style="max-width: 100%; border-radius: 4px; margin-bottom: 8px;">`;
      }
      content += `<p style="margin: 0 0 4px 0;"><a href="${escapeHtml(ext.uri)}" style="font-weight: bold; color: #0066cc;">${escapeHtml(ext.title || ext.uri)}</a></p>`;
      if (ext.description) {
        content += `<p style="margin: 0; font-size: 14px; color: #666;">${escapeHtml(ext.description)}</p>`;
      }
      content += `</div>`;
    }

    // Quote posts (record embed) - render inline only if not skipping
    if (AppBskyEmbedRecord.isView(embed) && !skipQuoteInline) {
      const recordEmbed = embed.record;
      if (AppBskyEmbedRecord.isViewRecord(recordEmbed)) {
        // Create a mock PostView for the quoted record
        const quotedPost: AppBskyFeedDefs.PostView = {
          uri: recordEmbed.uri,
          cid: recordEmbed.cid,
          author: recordEmbed.author,
          record: recordEmbed.value,
          embed: recordEmbed.embeds?.[0],
          indexedAt: recordEmbed.indexedAt,
        };
        content += renderQuotedPost(quotedPost);
      }
    }

    // Record with media (images/video + quote) - handle both parts
    if (AppBskyEmbedRecordWithMedia.isView(embed)) {
      const mediaEmbed = embed.media;
      const recordEmbed = embed.record.record;

      // First render the media (images or external)
      if (AppBskyEmbedImages.isView(mediaEmbed)) {
        if (mediaEmbed.images.length > 1) {
          const galleryId = `bsky-gallery-${post.cid.slice(0, 8)}`;
          content += `<div class="image-gallery" data-gallery-id="${galleryId}">`;
          content += `<div class="gallery-container">`;
          for (let i = 0; i < mediaEmbed.images.length; i++) {
            const image = mediaEmbed.images[i];
            const imageUrl = image.fullsize || image.thumb;
            content += `<div class="gallery-slide${i === 0 ? ' active' : ''}" data-index="${i}">`;
            content += `<img src="${imageUrl}" alt="${escapeHtml(image.alt || '')} (${i + 1}/${mediaEmbed.images.length})" loading="lazy">`;
            content += `</div>`;
          }
          content += `</div>`;
          content += `<div class="gallery-nav">`;
          content += `<button class="gallery-btn prev" data-dir="prev">‹</button>`;
          content += `<span class="gallery-counter">1 / ${mediaEmbed.images.length}</span>`;
          content += `<button class="gallery-btn next" data-dir="next">›</button>`;
          content += `</div>`;
          content += `</div>`;
        } else {
          for (const image of mediaEmbed.images) {
            const imageUrl = image.fullsize || image.thumb;
            content += `<p><img src="${imageUrl}" alt="${escapeHtml(image.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`;
          }
        }
      }

      if (AppBskyEmbedExternal.isView(mediaEmbed)) {
        const ext = mediaEmbed.external;
        content += `<div style="border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-top: 12px; background: #f9f9f9;">`;
        if (ext.thumb) {
          content += `<img src="${ext.thumb}" alt="" style="max-width: 100%; border-radius: 4px; margin-bottom: 8px;">`;
        }
        content += `<p style="margin: 0 0 4px 0;"><a href="${escapeHtml(ext.uri)}" style="font-weight: bold; color: #0066cc;">${escapeHtml(ext.title || ext.uri)}</a></p>`;
        if (ext.description) {
          content += `<p style="margin: 0; font-size: 14px; color: #666;">${escapeHtml(ext.description)}</p>`;
        }
        content += `</div>`;
      }

      // Then render the quoted post inline only if not skipping
      if (AppBskyEmbedRecord.isViewRecord(recordEmbed) && !skipQuoteInline) {
        const quotedPost: AppBskyFeedDefs.PostView = {
          uri: recordEmbed.uri,
          cid: recordEmbed.cid,
          author: recordEmbed.author,
          record: recordEmbed.value,
          embed: recordEmbed.embeds?.[0],
          indexedAt: recordEmbed.indexedAt,
        };
        content += renderQuotedPost(quotedPost);
      }
    }
  }

  return content;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPostUrl(post: AppBskyFeedDefs.PostView): string {
  // Extract rkey from URI: at://did:plc:xxx/app.bsky.feed.post/rkey
  const uri = post.uri;
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];

  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

/**
 * Given a post URI, fetch its full thread and return all posts from root to the post itself.
 * Returns posts in chronological order (root first). Only follows the direct reply chain,
 * not sibling replies.
 */
async function fetchThreadAncestors(bskyAgent: BskyAgent, postUri: string): Promise<AppBskyFeedDefs.PostView[]> {
  try {
    const threadResponse = await bskyAgent.getPostThread({ uri: postUri, depth: 0, parentHeight: 20 });
    if (!threadResponse.success) return [];

    // Walk up the parent chain collecting ancestors
    const ancestors: AppBskyFeedDefs.PostView[] = [];
    let current = threadResponse.data.thread;

    // First collect the thread post itself
    if (AppBskyFeedDefs.isThreadViewPost(current)) {
      // Walk up the parent chain
      let parent = current.parent;
      while (parent && AppBskyFeedDefs.isThreadViewPost(parent)) {
        ancestors.unshift(parent.post); // prepend so root ends up first
        parent = parent.parent;
      }
    }

    return ancestors;
  } catch (err) {
    logger.debug(`Failed to fetch thread ancestors for ${postUri}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Render a parent/ancestor post as an inline quote card (for reply context)
 */
function renderReplyContext(post: AppBskyFeedDefs.PostView): string {
  const record = post.record as { text?: string };
  let html = `<blockquote style="border-left: 3px solid #0085ff; margin: 12px 0; padding: 8px 12px; background: rgba(0, 133, 255, 0.08); border-radius: 0 8px 8px 0;">`;

  // Author line with avatar
  const avatarHtml = post.author.avatar
    ? `<img class="avatar" src="${escapeHtml(post.author.avatar)}" alt="" width="20" height="20" loading="lazy" style="border-radius: 50%; vertical-align: middle; margin-right: 4px;">`
    : '';
  html += `<p style="margin: 0 0 6px 0;">${avatarHtml}<a href="https://bsky.app/profile/${escapeHtml(post.author.handle)}" style="font-weight: bold; color: #0085ff;">@${escapeHtml(post.author.handle)}</a></p>`;

  // Post text
  if (record.text) {
    html += `<p style="margin: 0 0 6px 0;">${escapeHtml(record.text)}</p>`;
  }

  // Inline images from the parent
  const embed = post.embed;
  if (embed && AppBskyEmbedImages.isView(embed)) {
    for (const image of embed.images) {
      const imageUrl = image.fullsize || image.thumb;
      html += `<p style="margin: 4px 0;"><img src="${imageUrl}" alt="${escapeHtml(image.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`;
    }
  }

  // External link card from parent
  if (embed && AppBskyEmbedExternal.isView(embed)) {
    const ext = embed.external;
    if (ext.thumb) {
      html += `<p style="margin: 4px 0;"><img src="${ext.thumb}" alt="" style="max-width: 100%; border-radius: 4px;"></p>`;
    }
    html += `<p style="margin: 4px 0;"><a href="${escapeHtml(ext.uri)}" style="color: #0085ff;">${escapeHtml(ext.title || ext.uri)}</a></p>`;
  }

  html += `</blockquote>`;
  return html;
}

/**
 * Convert a PostView to a DigestPost
 * @param skipQuoteInline - if true, don't render quote posts inline (they'll be separate thread posts)
 */
function postViewToDigest(
  post: AppBskyFeedDefs.PostView,
  rootUri?: string,
  parentUri?: string,
  repostedBy?: string,
  replyContext?: string,
  skipQuoteInline: boolean = false
): DigestPost {
  let content = extractPostContent(post, skipQuoteInline);

  // Append reply context (parent posts rendered as quote cards)
  if (replyContext) {
    content += replyContext;
  }

  const url = getPostUrl(post);
  const postId = post.uri.split('/').pop() || post.cid;

  return {
    postId,
    title: `@${post.author.handle}: ${(post.record as { text?: string }).text?.substring(0, 100) || 'Post'}`,
    content,
    url,
    author: `@${post.author.handle}`,
    publishedAt: new Date(post.indexedAt),
    rawJson: post,
    metadata: {
      avatarUrl: post.author.avatar || undefined,
      repostedBy,
      rootUri,
      parentUri,
    },
  };
}

export async function pollBluesky(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.bluesky_enabled) {
    logger.debug('Bluesky polling disabled');
    return [];
  }

  const bskyAgent = await getAgent();

  if (!bskyAgent) {
    logger.warn('Bluesky not authenticated, skipping poll');
    return [];
  }

  logger.info('Polling Bluesky timeline...');

  try {
    // Fetch timeline
    const timeline = await bskyAgent.getTimeline({ limit: 100 });

    if (!timeline.success) {
      throw new Error('Failed to fetch Bluesky timeline');
    }

    // Deduplicate posts by URI (same post can appear multiple times via reposts)
    const seenUris = new Set<string>();
    const uniqueFeed = timeline.data.feed.filter((feedPost) => {
      const uri = feedPost.post.uri;
      if (seenUris.has(uri)) {
        return false;
      }
      seenUris.add(uri);
      return true;
    });

    const duplicatesRemoved = timeline.data.feed.length - uniqueFeed.length;
    if (duplicatesRemoved > 0) {
      logger.debug(`Bluesky: filtered out ${duplicatesRemoved} duplicate posts`);
    }

    // Take first N posts (timeline is already in chronological order)
    const topPosts = uniqueFeed.slice(0, config.bluesky_top_n);

    const digestPosts: DigestPost[] = [];
    // Track URIs we've already added to avoid duplicates from thread fetching
    const addedUris = new Set<string>();

    for (const feedViewPost of topPosts) {
      const post = feedViewPost.post;

      // Detect repost
      const reason = feedViewPost.reason as { $type?: string; by?: { handle?: string; displayName?: string } } | undefined;
      const isRepost = reason?.$type === 'app.bsky.feed.defs#reasonRepost';
      const repostedBy = isRepost ? (reason?.by?.displayName || reason?.by?.handle || undefined) : undefined;

      // Detect reply thread info
      const record = post.record as { reply?: { root?: { uri?: string }; parent?: { uri?: string } } };
      let rootUri = record.reply?.root?.uri || undefined;
      let parentUri = record.reply?.parent?.uri || undefined;

      // Check if this post quotes another post (not a reply, but embedding a quote)
      const quotedPost = extractQuotedPost(post.embed);
      const hasQuote = quotedPost !== null && !rootUri; // Only treat as quote thread if not already a reply

      if (hasQuote && quotedPost) {
        // Quote post detected - add quoted post first, then the quoting post
        // This creates a thread where the quoted content appears first
        const quotedUri = quotedPost.uri;

        // Add the quoted post as the root of the thread (if not already added)
        if (!addedUris.has(quotedUri)) {
          addedUris.add(quotedUri);
          // Quoted post has no rootUri/parentUri - it's the thread root
          digestPosts.push(postViewToDigest(quotedPost));
        }

        // Add the quoting post with rootUri/parentUri pointing to the quoted post
        if (!addedUris.has(post.uri)) {
          addedUris.add(post.uri);
          // Skip inline quote rendering since the quoted content is now a separate thread item
          digestPosts.push(postViewToDigest(post, quotedUri, quotedUri, repostedBy, undefined, true));
        }
      } else if (rootUri) {
        // This post is a reply — fetch ancestors for context
        const ancestors = await fetchThreadAncestors(bskyAgent, post.uri);

        if (isRepost) {
          // For reposts of replies: embed parent context inline (like the app shows it)
          // Don't add ancestors as separate posts — show them as quote cards within this post
          let replyContext = '';
          for (const ancestor of ancestors) {
            replyContext += renderReplyContext(ancestor);
          }

          if (!addedUris.has(post.uri)) {
            addedUris.add(post.uri);
            digestPosts.push(postViewToDigest(post, rootUri, parentUri, repostedBy, replyContext));
          }
        } else {
          // For non-reposted replies: add ancestors as separate posts for thread grouping
          if (!addedUris.has(rootUri)) {
            for (const ancestor of ancestors) {
              if (!addedUris.has(ancestor.uri)) {
                addedUris.add(ancestor.uri);
                const ancestorRecord = ancestor.record as { reply?: { root?: { uri?: string }; parent?: { uri?: string } } };
                digestPosts.push(postViewToDigest(
                  ancestor,
                  ancestorRecord.reply?.root?.uri,
                  ancestorRecord.reply?.parent?.uri,
                ));
              }
            }
          }

          if (!addedUris.has(post.uri)) {
            addedUris.add(post.uri);
            digestPosts.push(postViewToDigest(post, rootUri, parentUri));
          }
        }
      } else {
        // Standalone post (not a reply, not a quote)
        if (!addedUris.has(post.uri)) {
          addedUris.add(post.uri);
          digestPosts.push(postViewToDigest(post, rootUri, parentUri, repostedBy));
        }
      }
    }

    logger.info(`Bluesky poll complete: found ${digestPosts.length} posts`);
    return digestPosts;
  } catch (err) {
    logger.error('Bluesky polling failed:', err);
    throw err;
  }
}

export async function testBlueskyConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const bskyAgent = await getAgent();

    if (!bskyAgent) {
      return { success: false, error: 'Invalid credentials' };
    }

    // Try to fetch profile to verify connection
    const profile = await bskyAgent.getProfile({ actor: getConfig().bluesky_handle });

    if (profile.success) {
      return { success: true };
    }

    return { success: false, error: 'Failed to fetch profile' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
