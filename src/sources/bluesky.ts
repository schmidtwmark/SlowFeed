import { BskyAgent, AppBskyFeedDefs, AppBskyEmbedImages, AppBskyEmbedExternal } from '@atproto/api';
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

function extractPostContent(post: AppBskyFeedDefs.PostView): string {
  let content = '';
  const record = post.record as { text?: string };

  // Add post text
  if (record.text) {
    content += `<p>${escapeHtml(record.text)}</p>`;
  }

  // Handle embeds
  const embed = post.embed;

  if (embed) {
    // Images - use fullsize for better quality
    if (AppBskyEmbedImages.isView(embed)) {
      for (const image of embed.images) {
        const imageUrl = image.fullsize || image.thumb;
        content += `<p><img src="${imageUrl}" alt="${escapeHtml(image.alt || '')}" style="max-width: 100%; border-radius: 8px;"></p>`;
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

    // Quote posts - styled blockquote
    if (AppBskyFeedDefs.isPostView(embed.record)) {
      const quotedPost = embed.record;
      const quotedRecord = quotedPost.record as { text?: string };
      content += `<blockquote style="border-left: 3px solid #0085ff; margin: 12px 0; padding: 8px 12px; background: #f5f5f5;">`;
      content += `<p style="margin: 0 0 8px 0;"><a href="https://bsky.app/profile/${quotedPost.author.handle}" style="font-weight: bold; color: #0066cc;">@${quotedPost.author.handle}</a></p>`;
      if (quotedRecord.text) {
        content += `<p style="margin: 0;">${escapeHtml(quotedRecord.text)}</p>`;
      }
      content += `</blockquote>`;
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

    for (const feedViewPost of topPosts) {
      const post = feedViewPost.post;
      const content = extractPostContent(post);
      const url = getPostUrl(post);

      // Extract post ID from URI
      const postId = post.uri.split('/').pop() || post.cid;

      // Detect repost
      const reason = feedViewPost.reason as { $type?: string; by?: { handle?: string; displayName?: string } } | undefined;
      const isRepost = reason?.$type === 'app.bsky.feed.defs#reasonRepost';
      const repostedBy = isRepost ? (reason?.by?.displayName || reason?.by?.handle || undefined) : undefined;

      // Detect reply thread info
      const record = post.record as { reply?: { root?: { uri?: string }; parent?: { uri?: string } } };
      const rootUri = record.reply?.root?.uri || undefined;
      const parentUri = record.reply?.parent?.uri || undefined;

      digestPosts.push({
        postId,
        title: `@${post.author.handle}: ${(post.record as { text?: string }).text?.substring(0, 100) || 'Post'}`,
        content,
        url,
        author: `@${post.author.handle}`,
        publishedAt: new Date(post.indexedAt),
        rawJson: post,
        metadata: {
          repostedBy,
          rootUri,
          parentUri,
        },
      });
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
