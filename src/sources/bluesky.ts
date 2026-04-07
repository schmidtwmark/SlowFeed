import { BskyAgent, AppBskyFeedDefs, AppBskyEmbedImages, AppBskyEmbedExternal, AppBskyEmbedRecord, AppBskyEmbedRecordWithMedia } from '@atproto/api';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia, PostLink } from '../types/index.js';

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

// ---- Helpers ----

function getPostUrl(post: AppBskyFeedDefs.PostView): string {
  const parts = post.uri.split('/');
  const rkey = parts[parts.length - 1];
  return `https://bsky.app/profile/${post.author.handle}/post/${rkey}`;
}

function extractImagesFromEmbed(imageView: AppBskyEmbedImages.View): PostMedia[] {
  return imageView.images.map((image) => ({
    type: 'image' as const,
    url: image.fullsize || image.thumb,
    thumbnailUrl: image.thumb,
    alt: image.alt || undefined,
  }));
}

function extractExternalLink(externalView: AppBskyEmbedExternal.View): PostLink {
  const ext = externalView.external;
  return {
    url: ext.uri,
    title: ext.title || undefined,
    description: ext.description || undefined,
    imageUrl: ext.thumb || undefined,
  };
}

/**
 * Extract quoted PostView from an embed (if any)
 */
function extractQuotedPostView(embed: AppBskyFeedDefs.PostView['embed']): AppBskyFeedDefs.PostView | null {
  if (!embed) return null;

  if (AppBskyEmbedRecord.isView(embed)) {
    const rec = embed.record;
    if (AppBskyEmbedRecord.isViewRecord(rec)) {
      return { uri: rec.uri, cid: rec.cid, author: rec.author, record: rec.value, embed: rec.embeds?.[0], indexedAt: rec.indexedAt };
    }
  }

  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    const rec = embed.record.record;
    if (AppBskyEmbedRecord.isViewRecord(rec)) {
      return { uri: rec.uri, cid: rec.cid, author: rec.author, record: rec.value, embed: rec.embeds?.[0], indexedAt: rec.indexedAt };
    }
  }

  return null;
}

/**
 * Extract media and links from a post's embed (NOT quote embeds — those become quotedPost)
 */
function extractMediaAndLinks(post: AppBskyFeedDefs.PostView): { media: PostMedia[]; links: PostLink[] } {
  const media: PostMedia[] = [];
  const links: PostLink[] = [];
  const embed = post.embed;
  if (!embed) return { media, links };

  if (AppBskyEmbedImages.isView(embed)) {
    media.push(...extractImagesFromEmbed(embed));
  }

  if (AppBskyEmbedExternal.isView(embed)) {
    links.push(extractExternalLink(embed));
  }

  // Record with media: extract the media part (images/links), quote part handled separately
  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    const mediaEmbed = embed.media;
    if (AppBskyEmbedImages.isView(mediaEmbed)) {
      media.push(...extractImagesFromEmbed(mediaEmbed));
    }
    if (AppBskyEmbedExternal.isView(mediaEmbed)) {
      links.push(extractExternalLink(mediaEmbed));
    }
  }

  return { media, links };
}

/**
 * Convert a PostView into a tree-node DigestPost.
 * Recursively handles quotedPost. Does NOT handle replies (caller does that).
 */
function postViewToNode(post: AppBskyFeedDefs.PostView, repostedBy?: string): DigestPost {
  const record = post.record as { text?: string };
  const url = getPostUrl(post);
  const postId = post.uri.split('/').pop() || post.cid;
  const { media, links } = extractMediaAndLinks(post);

  // Recursively convert quoted post
  const quotedView = extractQuotedPostView(post.embed);
  const quotedPost = quotedView ? postViewToNode(quotedView) : undefined;

  return {
    postId,
    title: `@${post.author.handle}: ${record.text?.substring(0, 100) || 'Post'}`,
    content: record.text || '',
    url,
    author: `@${post.author.handle}`,
    publishedAt: new Date(post.indexedAt),
    metadata: {
      avatarUrl: post.author.avatar || undefined,
      repostedBy,
    },
    media: media.length > 0 ? media : undefined,
    links: links.length > 0 ? links : undefined,
    quotedPost,
  };
}

/**
 * Fetch ancestors for a post and build a nested tree from root → ... → this post.
 * Returns the root DigestPost with the timeline post as the deepest leaf in replies[].
 */
async function buildThreadTree(
  bskyAgent: BskyAgent,
  post: AppBskyFeedDefs.PostView,
  repostedBy?: string
): Promise<DigestPost> {
  const leafNode = postViewToNode(post, repostedBy);

  try {
    const threadResponse = await bskyAgent.getPostThread({ uri: post.uri, depth: 0, parentHeight: 20 });
    if (!threadResponse.success) return leafNode;

    // Collect ancestors from root to parent (not including the post itself)
    const ancestors: AppBskyFeedDefs.PostView[] = [];
    const current = threadResponse.data.thread;
    if (AppBskyFeedDefs.isThreadViewPost(current)) {
      let parent = current.parent;
      while (parent && AppBskyFeedDefs.isThreadViewPost(parent)) {
        ancestors.unshift(parent.post);
        parent = parent.parent;
      }
    }

    if (ancestors.length === 0) return leafNode;

    // Build the tree: root → ancestor1 → ancestor2 → ... → leaf
    // Start from the leaf and wrap upward
    let tree = leafNode;
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const ancestorNode = postViewToNode(ancestors[i]);
      ancestorNode.replies = [tree];
      tree = ancestorNode;
    }

    return tree;
  } catch (err) {
    logger.debug(`Failed to build thread tree for ${post.uri}: ${(err as Error).message}`);
    return leafNode;
  }
}

/**
 * Recursively merge an incoming thread tree into an existing one.
 * Walks both trees in parallel, matching children by postId.
 * New children are inserted; existing children are merged recursively.
 */
function mergeIntoTree(existing: DigestPost, incoming: DigestPost): void {
  if (!incoming.replies) return;

  for (const incomingReply of incoming.replies) {
    const existingReply = existing.replies?.find(r => r.postId === incomingReply.postId);

    if (existingReply) {
      // Same post exists at this level — recurse to merge their children
      mergeIntoTree(existingReply, incomingReply);
    } else {
      // New reply at this level — add it
      if (!existing.replies) {
        existing.replies = [incomingReply];
      } else {
        existing.replies.push(incomingReply);
      }
    }
  }
}

/**
 * Merge digest posts that share the same root postId.
 * Each buildThreadTree call produces a linear chain (root → ... → leaf).
 * This merges overlapping chains into a proper tree by matching nodes at each depth.
 */
function mergeThreadsByRoot(posts: DigestPost[]): DigestPost[] {
  const rootMap = new Map<string, DigestPost>();
  const order: string[] = [];

  for (const post of posts) {
    const rootId = post.postId;

    if (!rootMap.has(rootId)) {
      rootMap.set(rootId, post);
      order.push(rootId);
    } else {
      mergeIntoTree(rootMap.get(rootId)!, post);
    }
  }

  return order.map(id => rootMap.get(id)!);
}

// ---- Main poll function ----

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
    const timeline = await bskyAgent.getTimeline({ limit: 100 });

    if (!timeline.success) {
      throw new Error('Failed to fetch Bluesky timeline');
    }

    // Deduplicate posts by URI
    const seenUris = new Set<string>();
    const uniqueFeed = timeline.data.feed.filter((fp) => {
      if (seenUris.has(fp.post.uri)) return false;
      seenUris.add(fp.post.uri);
      return true;
    });

    const duplicatesRemoved = timeline.data.feed.length - uniqueFeed.length;
    if (duplicatesRemoved > 0) {
      logger.debug(`Bluesky: filtered out ${duplicatesRemoved} duplicate posts`);
    }

    const topPosts = uniqueFeed.slice(0, config.bluesky_top_n);
    const digestPosts: DigestPost[] = [];
    const addedUris = new Set<string>();

    // Cache thread fetches by root URI to avoid duplicate API calls
    const threadCache = new Map<string, DigestPost>();

    for (const feedViewPost of topPosts) {
      const post = feedViewPost.post;
      if (addedUris.has(post.uri)) continue;
      addedUris.add(post.uri);

      // Detect repost
      const reason = feedViewPost.reason as { $type?: string; by?: { handle?: string; displayName?: string } } | undefined;
      const isRepost = reason?.$type === 'app.bsky.feed.defs#reasonRepost';
      const repostedBy = isRepost ? (reason?.by?.displayName || reason?.by?.handle || undefined) : undefined;

      // Detect if this is a reply
      const record = post.record as { reply?: { root?: { uri?: string }; parent?: { uri?: string } } };
      const isReply = !!record.reply?.root?.uri;

      if (isReply) {
        // Build full thread tree: root → ... → this post
        const tree = await buildThreadTree(bskyAgent, post, repostedBy);
        digestPosts.push(tree);
      } else {
        // Standalone post or quote post — just convert directly
        const node = postViewToNode(post, repostedBy);
        digestPosts.push(node);
      }
    }

    // Merge threads that share the same root post.
    // e.g. if post A appears standalone AND as root of thread A→B, keep only A→B.
    // If multiple threads share root A (A→B and A→C), merge into A→[B,C].
    const mergedPosts = mergeThreadsByRoot(digestPosts);

    logger.info(`Bluesky poll complete: found ${mergedPosts.length} posts (${digestPosts.length} before merge)`);
    return mergedPosts;
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

    const profile = await bskyAgent.getProfile({ actor: getConfig().bluesky_handle });

    if (profile.success) {
      return { success: true };
    }

    return { success: false, error: 'Failed to fetch profile' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
