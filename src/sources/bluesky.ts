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
 * Convert a PostView to a DigestPost
 */
function postViewToDigest(post: AppBskyFeedDefs.PostView, rootUri?: string, parentUri?: string, repostedBy?: string): DigestPost {
  const content = extractPostContent(post);
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
      const rootUri = record.reply?.root?.uri || undefined;
      const parentUri = record.reply?.parent?.uri || undefined;

      // If this post is a reply, fetch the full thread (ancestors)
      if (rootUri && !addedUris.has(rootUri)) {
        const ancestors = await fetchThreadAncestors(bskyAgent, post.uri);
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

      // Add the post itself
      if (!addedUris.has(post.uri)) {
        addedUris.add(post.uri);
        digestPosts.push(postViewToDigest(post, rootUri, parentUri, repostedBy));
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
