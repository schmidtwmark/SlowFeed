import { BskyAgent, AppBskyFeedDefs, AppBskyEmbedImages, AppBskyEmbedExternal } from '@atproto/api';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

let agent: BskyAgent | null = null;
let lastLoginTime: number = 0;
const SESSION_DURATION = 60 * 60 * 1000; // 1 hour

interface ScoredPost {
  post: AppBskyFeedDefs.FeedViewPost;
  score: number;
}

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

function calculateScore(post: AppBskyFeedDefs.FeedViewPost): number {
  const { likeCount = 0, repostCount = 0, replyCount = 0 } = post.post;

  // Base engagement score
  let score = likeCount * 1 + repostCount * 2 + replyCount * 1.5;

  // Recency bonus (decay posts older than 24h)
  const postDate = new Date(post.post.indexedAt);
  const ageHours = (Date.now() - postDate.getTime()) / (1000 * 60 * 60);

  if (ageHours < 24) {
    // Boost recent posts
    score *= 1 + (24 - ageHours) / 24;
  } else {
    // Decay old posts
    score *= Math.max(0.1, 1 - (ageHours - 24) / 72);
  }

  return score;
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

    // Score and sort posts
    const scoredPosts: ScoredPost[] = timeline.data.feed.map((post) => ({
      post,
      score: calculateScore(post),
    }));

    scoredPosts.sort((a, b) => b.score - a.score);

    // Take top N posts
    const topPosts = scoredPosts.slice(0, config.bluesky_top_n);

    const digestPosts: DigestPost[] = [];

    for (const { post: feedViewPost } of topPosts) {
      const post = feedViewPost.post;

      // Skip if this is a repost and we already have the original
      if (feedViewPost.reason && AppBskyFeedDefs.isReasonRepost(feedViewPost.reason)) {
        // Still include reposts, but mark them
      }

      const content = extractPostContent(post);
      const url = getPostUrl(post);

      // Extract post ID from URI
      const postId = post.uri.split('/').pop() || post.cid;

      digestPosts.push({
        postId,
        title: `@${post.author.handle}: ${(post.record as { text?: string }).text?.substring(0, 100) || 'Post'}`,
        content,
        url,
        author: `@${post.author.handle}`,
        publishedAt: new Date(post.indexedAt),
        rawJson: post,
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
