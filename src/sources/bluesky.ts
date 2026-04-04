import { BskyAgent, AppBskyFeedDefs, AppBskyEmbedImages, AppBskyEmbedExternal, AppBskyEmbedRecord, AppBskyEmbedRecordWithMedia } from '@atproto/api';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia, PostLink, PostEmbed } from '../types/index.js';

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
 * Extract a PostView into a PostEmbed of type 'quote'
 */
function postViewToQuoteEmbed(quotedPost: AppBskyFeedDefs.PostView): PostEmbed {
  const quotedRecord = quotedPost.record as { text?: string };

  // Extract the first image from the quoted post's embed (if any)
  let imageUrl: string | undefined;
  const embed = quotedPost.embed;
  if (embed) {
    if (AppBskyEmbedImages.isView(embed) && embed.images.length > 0) {
      imageUrl = embed.images[0].thumb || embed.images[0].fullsize;
    } else if (AppBskyEmbedRecordWithMedia.isView(embed)) {
      const mediaEmbed = embed.media;
      if (AppBskyEmbedImages.isView(mediaEmbed) && mediaEmbed.images.length > 0) {
        imageUrl = mediaEmbed.images[0].thumb || mediaEmbed.images[0].fullsize;
      }
    } else if (AppBskyEmbedExternal.isView(embed) && embed.external.thumb) {
      imageUrl = embed.external.thumb;
    }
  }

  return {
    type: 'quote',
    author: `@${quotedPost.author.handle}`,
    authorAvatarUrl: quotedPost.author.avatar || undefined,
    text: quotedRecord.text || undefined,
    url: getPostUrl(quotedPost),
    imageUrl,
    publishedAt: quotedPost.indexedAt,
  };
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
 * Extract images from an image embed view into PostMedia[]
 */
function extractImagesFromEmbed(imageView: AppBskyEmbedImages.View): PostMedia[] {
  return imageView.images.map((image) => ({
    type: 'image' as const,
    url: image.fullsize || image.thumb,
    thumbnailUrl: image.thumb,
    alt: image.alt || undefined,
  }));
}

/**
 * Extract an external link embed into a PostLink
 */
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
 * Extract structured data (media, links, embeds) from a post's embed
 * @param skipQuoteInline - if true, don't extract quote posts (they'll be separate thread posts)
 */
function extractStructuredData(
  post: AppBskyFeedDefs.PostView,
  skipQuoteInline: boolean = false
): { media: PostMedia[]; links: PostLink[]; embeds: PostEmbed[] } {
  const media: PostMedia[] = [];
  const links: PostLink[] = [];
  const embeds: PostEmbed[] = [];

  const embed = post.embed;
  if (!embed) return { media, links, embeds };

  // Images
  if (AppBskyEmbedImages.isView(embed)) {
    media.push(...extractImagesFromEmbed(embed));
  }

  // External links
  if (AppBskyEmbedExternal.isView(embed)) {
    links.push(extractExternalLink(embed));
  }

  // Quote posts (record embed)
  if (AppBskyEmbedRecord.isView(embed) && !skipQuoteInline) {
    const recordEmbed = embed.record;
    if (AppBskyEmbedRecord.isViewRecord(recordEmbed)) {
      const quotedPost: AppBskyFeedDefs.PostView = {
        uri: recordEmbed.uri,
        cid: recordEmbed.cid,
        author: recordEmbed.author,
        record: recordEmbed.value,
        embed: recordEmbed.embeds?.[0],
        indexedAt: recordEmbed.indexedAt,
      };
      embeds.push(postViewToQuoteEmbed(quotedPost));
    }
  }

  // Record with media (images/video + quote)
  if (AppBskyEmbedRecordWithMedia.isView(embed)) {
    const mediaEmbed = embed.media;
    const recordEmbed = embed.record.record;

    // Extract the media part
    if (AppBskyEmbedImages.isView(mediaEmbed)) {
      media.push(...extractImagesFromEmbed(mediaEmbed));
    }

    if (AppBskyEmbedExternal.isView(mediaEmbed)) {
      links.push(extractExternalLink(mediaEmbed));
    }

    // Extract the quote part
    if (AppBskyEmbedRecord.isViewRecord(recordEmbed) && !skipQuoteInline) {
      const quotedPost: AppBskyFeedDefs.PostView = {
        uri: recordEmbed.uri,
        cid: recordEmbed.cid,
        author: recordEmbed.author,
        record: recordEmbed.value,
        embed: recordEmbed.embeds?.[0],
        indexedAt: recordEmbed.indexedAt,
      };
      embeds.push(postViewToQuoteEmbed(quotedPost));
    }
  }

  return { media, links, embeds };
}

/**
 * Convert ancestor/parent posts into PostEmbed[] entries of type 'quote' for reply context
 */
function ancestorsToEmbeds(ancestors: AppBskyFeedDefs.PostView[]): PostEmbed[] {
  return ancestors.map((ancestor) => postViewToQuoteEmbed(ancestor));
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
 * Convert a PostView to a DigestPost with structured data
 * @param skipQuoteInline - if true, don't extract quote posts inline (they'll be separate thread posts)
 * @param replyContextAncestors - ancestor posts to include as quote-type embeds for reply context
 */
function postViewToDigest(
  post: AppBskyFeedDefs.PostView,
  rootUri?: string,
  parentUri?: string,
  repostedBy?: string,
  replyContextAncestors?: AppBskyFeedDefs.PostView[],
  skipQuoteInline: boolean = false
): DigestPost {
  const record = post.record as { text?: string };
  const url = getPostUrl(post);
  const postId = post.uri.split('/').pop() || post.cid;

  // Extract structured data from embeds
  const { media, links, embeds } = extractStructuredData(post, skipQuoteInline);

  // Add reply context ancestors as quote-type embeds
  if (replyContextAncestors && replyContextAncestors.length > 0) {
    embeds.push(...ancestorsToEmbeds(replyContextAncestors));
  }

  return {
    postId,
    title: `@${post.author.handle}: ${record.text?.substring(0, 100) || 'Post'}`,
    content: record.text || '',
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
    media: media.length > 0 ? media : undefined,
    links: links.length > 0 ? links : undefined,
    embeds: embeds.length > 0 ? embeds : undefined,
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
        // Quote post — keep as a single post with the quoted content as an inline embed
        if (!addedUris.has(post.uri)) {
          addedUris.add(post.uri);
          digestPosts.push(postViewToDigest(post, undefined, undefined, repostedBy));
        }
      } else if (rootUri) {
        // This post is a reply — fetch ancestors for context
        const ancestors = await fetchThreadAncestors(bskyAgent, post.uri);

        if (isRepost) {
          // For reposts of replies: embed parent context inline (like the app shows it)
          // Don't add ancestors as separate posts — show them as quote embeds within this post
          if (!addedUris.has(post.uri)) {
            addedUris.add(post.uri);
            digestPosts.push(postViewToDigest(post, rootUri, parentUri, repostedBy, ancestors));
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
