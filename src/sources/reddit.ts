import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia, PostLink, PostComment } from '../types/index.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  url: string;
  permalink: string;
  selftext: string;
  score: number;
  numComments: number;
  createdUtc: number;
  thumbnail: string | null;
  isSelf: boolean;
  isImage: boolean;
  isVideo: boolean;
  isGallery: boolean;
  previewUrl: string | null;
}

interface RedditComment {
  author: string;
  body: string;
  score: number;
}

function getRedditCookies(): string {
  try {
    const config = getConfig();
    return config.reddit_cookies || '';
  } catch {
    return '';
  }
}

async function fetchPage(url: string): Promise<string> {
  const cookies = getRedditCookies();

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  if (cookies) {
    headers['Cookie'] = cookies;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

function extractPosts(html: string): RedditPost[] {
  const posts: RedditPost[] = [];

  // Match each post thing div - old.reddit.com structure
  // The data attributes may be in different orders, so we need to be flexible
  const thingRegex = /<div[^>]*class="[^"]*\bthing\b[^"]*"[^>]*>/gi;
  let match;

  while ((match = thingRegex.exec(html)) !== null) {
    const startIndex = match.index;
    // Find the end of this thing's opening tag to get all attributes
    const tagEnd = html.indexOf('>', startIndex) + 1;
    const openingTag = html.substring(startIndex, tagEnd);

    // Skip if not a link post (t3)
    if (!openingTag.includes('data-fullname="t3_')) continue;

    // Extract the thing block (approximate - get enough content)
    const blockEnd = html.indexOf('<div class=" thing', startIndex + 100);
    const thingBlock = html.substring(startIndex, blockEnd > startIndex ? blockEnd : startIndex + 5000);

    // Extract data attributes from opening tag
    const idMatch = openingTag.match(/data-fullname="t3_([^"]+)"/);
    const subredditMatch = openingTag.match(/data-subreddit="([^"]+)"/);
    const authorMatch = openingTag.match(/data-author="([^"]+)"/);
    const urlMatch = openingTag.match(/data-url="([^"]+)"/);
    const permalinkMatch = openingTag.match(/data-permalink="([^"]+)"/);
    const scoreMatch = openingTag.match(/data-score="([^"]+)"/);
    const commentsMatch = openingTag.match(/data-comments-count="([^"]+)"/);
    const timestampMatch = openingTag.match(/data-timestamp="([^"]+)"/);

    if (!idMatch) continue;

    const id = idMatch[1];
    const subreddit = subredditMatch ? subredditMatch[1] : 'unknown';
    const author = authorMatch ? authorMatch[1] : 'unknown';
    const postUrl = urlMatch ? urlMatch[1] : '';
    const permalink = permalinkMatch ? permalinkMatch[1] : `/r/${subreddit}/comments/${id}`;
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) || 0 : 0;
    const numComments = commentsMatch ? parseInt(commentsMatch[1], 10) || 0 : 0;
    const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : Date.now();

    // Extract title from the thing block
    const titleMatch = thingBlock.match(/<a[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/a>/i) ||
                       thingBlock.match(/<p class="title"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/is);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : 'Unknown Title';

    const isSelf = postUrl.startsWith('/r/') || postUrl.includes('reddit.com/r/');

    // Detect image URLs
    const imageExtensions = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;
    const imageHosts = /^https?:\/\/(i\.redd\.it|i\.imgur\.com|imgur\.com\/[a-zA-Z0-9]+\.|preview\.redd\.it|external-preview\.redd\.it)/i;
    const isImage = !isSelf && (imageExtensions.test(postUrl) || imageHosts.test(postUrl));

    // Detect video URLs
    const videoHosts = /^https?:\/\/(v\.redd\.it|gfycat\.com|redgifs\.com|streamable\.com)/i;
    const isVideo = !isSelf && videoHosts.test(postUrl);

    // Detect gallery URLs
    const isGallery = /reddit\.com\/gallery\//i.test(postUrl) || /\/gallery\//i.test(postUrl);

    // Try to extract preview URL from thing block
    let previewUrl: string | null = null;
    const previewMatch = thingBlock.match(/data-url="(https?:\/\/preview\.redd\.it\/[^"]+)"/i) ||
                         thingBlock.match(/data-url="(https?:\/\/i\.redd\.it\/[^"]+)"/i);
    if (previewMatch) {
      previewUrl = decodeHtmlEntities(previewMatch[1]);
    }

    // For imgur single images, convert to direct image URL
    let finalUrl = postUrl.startsWith('/') ? `https://old.reddit.com${postUrl}` : postUrl;
    if (finalUrl.match(/^https?:\/\/imgur\.com\/[a-zA-Z0-9]+$/)) {
      // Convert imgur.com/abc to i.imgur.com/abc.jpg
      finalUrl = finalUrl.replace('imgur.com/', 'i.imgur.com/') + '.jpg';
    }

    posts.push({
      id,
      title,
      author,
      subreddit,
      url: finalUrl,
      permalink: `https://old.reddit.com${permalink}`,
      selftext: '',
      score,
      numComments,
      createdUtc: timestamp / 1000,
      thumbnail: null,
      isSelf,
      isImage,
      isVideo,
      isGallery,
      previewUrl,
    });
  }

  return posts;
}

function extractComments(html: string, maxComments: number): RedditComment[] {
  const comments: RedditComment[] = [];

  // Find comment entries
  const commentAreaMatch = html.match(/<div class="commentarea">([\s\S]*?)(<div class="footer-parent">|$)/i);
  if (!commentAreaMatch) return comments;

  const commentArea = commentAreaMatch[1];

  // Match individual comments
  const commentRegex = /<div[^>]*class="[^"]*comment[^"]*"[^>]*data-author="([^"]+)"[^>]*>[\s\S]*?<div class="md"[^>]*>([\s\S]*?)<\/div>/gi;

  let match;
  while ((match = commentRegex.exec(commentArea)) !== null && comments.length < maxComments) {
    const author = match[1];
    const bodyHtml = match[2];

    if (author === '[deleted]') continue;

    // Clean up body
    const body = bodyHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (body && body.length > 5) {
      comments.push({ author, body, score: 0 });
    }
  }

  return comments;
}

interface RedditPostJson {
  selftextHtml: string;
  galleryImageUrls: string[];
  videoUrl: string | null;
  videoAudioUrl: string | null;
  previewUrl: string | null;
}

async function fetchPostJson(permalink: string): Promise<RedditPostJson | null> {
  try {
    const jsonUrl = `${permalink}.json`;
    const cookies = getRedditCookies();

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    };
    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const response = await fetch(jsonUrl, { headers });
    if (!response.ok) return null;

    const json = await response.json() as Array<{
      data: {
        children: Array<{
          data: {
            selftext_html?: string;
            selftext?: string;
            thumbnail?: string;
            preview?: {
              images?: Array<{
                source?: { url?: string; width?: number; height?: number };
                resolutions?: Array<{ url?: string; width?: number; height?: number }>;
              }>;
            };
            media_metadata?: Record<string, {
              status: string;
              s?: { u?: string; gif?: string };
            }>;
            gallery_data?: { items: Array<{ media_id: string }> };
            media?: {
              reddit_video?: {
                fallback_url?: string;
                dash_url?: string;
              };
            };
            secure_media?: {
              reddit_video?: {
                fallback_url?: string;
              };
            };
            crosspost_parent_list?: Array<{
              media?: {
                reddit_video?: {
                  fallback_url?: string;
                };
              };
              secure_media?: {
                reddit_video?: {
                  fallback_url?: string;
                };
              };
              preview?: {
                images?: Array<{
                  source?: { url?: string };
                }>;
              };
              media_metadata?: Record<string, {
                status: string;
                s?: { u?: string; gif?: string };
              }>;
              gallery_data?: { items: Array<{ media_id: string }> };
            }>;
          };
        }>;
      };
    }>;

    if (!Array.isArray(json) || json.length === 0) return null;

    const postData = json[0]?.data?.children?.[0]?.data;
    if (!postData) return null;

    // Check crosspost parent for media
    const crosspost = postData.crosspost_parent_list?.[0];

    // Extract selftext HTML
    const selftextHtml = postData.selftext_html
      ? decodeHtmlEntities(postData.selftext_html)
      : '';

    // Extract gallery images
    const galleryImageUrls: string[] = [];
    const mediaMetadata = postData.media_metadata || crosspost?.media_metadata;
    const galleryData = postData.gallery_data || crosspost?.gallery_data;

    if (mediaMetadata && galleryData) {
      // Use gallery_data.items for ordering
      for (const item of galleryData.items) {
        const meta = mediaMetadata[item.media_id];
        if (meta?.status === 'valid' && meta.s) {
          const url = meta.s.gif || meta.s.u;
          if (url) {
            // Reddit encodes URLs with &amp; in the JSON
            galleryImageUrls.push(url.replace(/&amp;/g, '&'));
          }
        }
      }
    } else if (mediaMetadata) {
      // No gallery_data ordering, just iterate
      for (const meta of Object.values(mediaMetadata)) {
        if (meta?.status === 'valid' && meta.s) {
          const url = meta.s.gif || meta.s.u;
          if (url) {
            galleryImageUrls.push(url.replace(/&amp;/g, '&'));
          }
        }
      }
    }

    // Extract video URL
    let videoUrl: string | null = null;
    let videoAudioUrl: string | null = null;
    const redditVideo = postData.media?.reddit_video
      || postData.secure_media?.reddit_video
      || crosspost?.media?.reddit_video
      || crosspost?.secure_media?.reddit_video;

    if (redditVideo?.fallback_url) {
      videoUrl = redditVideo.fallback_url;
      // Derive audio URL from the video URL
      const audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_AUDIO_128.mp4')
        .replace(/DASH_\d+\?/, 'DASH_AUDIO_128?');
      videoAudioUrl = audioUrl;
    }

    // Extract preview URL (for videos and other content)
    let previewUrl: string | null = null;
    const previewImages = postData.preview?.images || crosspost?.preview?.images;
    if (previewImages && previewImages.length > 0) {
      const sourceUrl = previewImages[0]?.source?.url;
      if (sourceUrl) {
        previewUrl = sourceUrl.replace(/&amp;/g, '&');
      }
    }

    return { selftextHtml, galleryImageUrls, videoUrl, videoAudioUrl, previewUrl };
  } catch (err) {
    logger.debug(`Failed to fetch post JSON for ${permalink}: ${(err as Error).message}`);
    return null;
  }
}

async function fetchPostWithComments(permalink: string, commentDepth: number): Promise<{ selftext: string; comments: RedditComment[] }> {
  try {
    const html = await fetchPage(permalink);

    // Extract selftext
    let selftext = '';
    const selftextMatch = html.match(/<div class="usertext-body"[^>]*>[\s\S]*?<div class="md"[^>]*>([\s\S]*?)<\/div>/i);
    if (selftextMatch) {
      selftext = selftextMatch[1]
        .replace(/<[^>]+>/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    const comments = extractComments(html, commentDepth * 3);

    return { selftext, comments };
  } catch (err) {
    logger.warn(`Failed to fetch comments for ${permalink}:`, err);
    return { selftext: '', comments: [] };
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

function stripHtmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function pollReddit(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.reddit_enabled) {
    logger.debug('Reddit polling disabled');
    return [];
  }

  const cookies = getRedditCookies();
  const isLoggedIn = cookies.length > 0;

  logger.info(`Polling Reddit (${isLoggedIn ? 'logged in' : 'anonymous'})...`);

  try {
    // Fetch homepage - if logged in with cookies, this will be personalized
    const html = await fetchPage('https://old.reddit.com/');

    const posts = extractPosts(html);

    if (posts.length === 0) {
      logger.warn('No posts found - check if cookies are valid or if old.reddit.com structure changed');
    }

    // Filter out ads (posts from u_* subreddits are promoted/sponsored content)
    const filteredPosts = posts.filter(post => !post.subreddit.startsWith('u_'));
    const adsFiltered = posts.length - filteredPosts.length;
    logger.info(`Found ${posts.length} posts on Reddit (filtered ${adsFiltered} ads)`);

    // Take top N posts
    const topPosts = filteredPosts.slice(0, config.reddit_top_n);

    const digestPosts: DigestPost[] = [];

    for (const post of topPosts) {
      const media: PostMedia[] = [];
      const links: PostLink[] = [];
      let postComments: PostComment[] = [];
      let content = '';

      // Fetch JSON data for rich content (galleries, videos, selftext)
      const postJson = await fetchPostJson(post.permalink);

      // Gallery posts: each image becomes a media entry
      if (post.isGallery && postJson && postJson.galleryImageUrls.length > 0) {
        for (let i = 0; i < postJson.galleryImageUrls.length; i++) {
          media.push({
            type: 'image',
            url: postJson.galleryImageUrls[i],
            alt: `${post.title} (${i + 1}/${postJson.galleryImageUrls.length})`,
          });
        }
      } else if (post.isImage) {
        // Single image post
        media.push({
          type: 'image',
          url: post.url,
          alt: post.title,
        });
      }

      // Video posts
      if (post.isVideo) {
        const videoUrl = postJson?.videoUrl;
        const videoPreview = postJson?.previewUrl || post.previewUrl;

        if (videoUrl) {
          media.push({
            type: 'video',
            url: videoUrl,
            thumbnailUrl: videoPreview || undefined,
            audioUrl: postJson?.videoAudioUrl || undefined,
          });
        }
      }

      // Selftext: convert HTML to plain text, truncate if needed
      if (postJson?.selftextHtml) {
        let plainText = stripHtmlToPlainText(decodeHtmlEntities(postJson.selftextHtml));
        if (plainText.length > 2000) {
          const truncateAt = plainText.lastIndexOf('.', 1800);
          const cutPoint = truncateAt > 1000 ? truncateAt + 1 : 1800;
          plainText = plainText.substring(0, cutPoint) + '...';
        }
        content = plainText;
      }

      // Fetch comments if enabled
      if (config.reddit_include_comments && post.numComments > 0) {
        const { comments } = await fetchPostWithComments(
          post.permalink,
          config.reddit_comment_depth
        );

        postComments = comments.map(c => ({
          author: c.author,
          body: c.body,
          score: c.score,
        }));

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        // Small delay even without comments to avoid rate limiting on JSON fetch
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Non-self link posts: add to links array
      if (!post.isSelf && !post.isImage && !post.isVideo && !post.isGallery && post.url) {
        const previewImageUrl = postJson?.previewUrl || post.previewUrl;
        links.push({
          url: post.url,
          title: post.title,
          imageUrl: previewImageUrl || undefined,
        });
      }

      digestPosts.push({
        postId: post.id,
        title: post.title,
        content,
        url: post.permalink,
        author: `u/${post.author}`,
        publishedAt: new Date(post.createdUtc * 1000),
        rawJson: post,
        metadata: {
          score: post.score,
          subreddit: post.subreddit,
          numComments: post.numComments,
        },
        ...(media.length > 0 ? { media } : {}),
        ...(links.length > 0 ? { links } : {}),
        ...(postComments.length > 0 ? { comments: postComments } : {}),
      });
    }

    logger.info(`Reddit poll complete: found ${digestPosts.length} posts`);
    return digestPosts;
  } catch (err) {
    logger.error('Reddit polling failed:', err);
    throw err;
  }
}
