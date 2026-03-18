import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatComments(comments: RedditComment[]): string {
  if (comments.length === 0) return '';

  let html = '<h4 style="margin: 16px 0 8px 0; font-size: 14px; color: #666;">Top Comments</h4>';
  for (const comment of comments) {
    html += `<div style="border-left: 3px solid #ff4500; padding: 8px 12px; margin: 8px 0; background: #fafafa;">`;
    html += `<div style="font-size: 13px; color: #666; margin-bottom: 4px;">`;
    html += `<strong style="color: #0066cc;">u/${escapeHtml(comment.author)}</strong>`;
    if (comment.score !== 0) {
      html += ` · ${comment.score} points`;
    }
    html += `</div>`;
    html += `<div style="line-height: 1.5;">${escapeHtml(comment.body)}</div>`;
    html += `</div>`;
  }
  return html;
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
      let content = '';

      // For image posts, embed the image
      if (post.isImage) {
        const imageUrl = post.url;
        content += `<p><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(post.title)}" style="max-width: 100%; border-radius: 8px;"></p>`;
      } else if (post.previewUrl && !post.isSelf) {
        // Use preview image for link posts if available
        content += `<p><img src="${escapeHtml(post.previewUrl)}" alt="Preview" style="max-width: 100%; border-radius: 8px;"></p>`;
      }

      // For video posts, show a link with indicator
      if (post.isVideo) {
        content += `<p style="padding: 12px; background: #f5f5f5; border-radius: 8px;">🎬 <a href="${escapeHtml(post.url)}" style="color: #0066cc;">View Video</a></p>`;
      }

      // Fetch comments if enabled
      if (config.reddit_include_comments && post.numComments > 0) {
        const { selftext, comments } = await fetchPostWithComments(
          post.permalink,
          config.reddit_comment_depth
        );

        if (selftext) {
          content += `<div style="margin: 12px 0; padding: 12px; background: #f9f9f9; border-radius: 8px; line-height: 1.6;">${escapeHtml(selftext)}</div>`;
        }

        content += formatComments(comments);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Add link for non-self, non-image, non-video posts
      if (!post.isSelf && !post.isImage && !post.isVideo && post.url) {
        // Show as a link card
        content += `<div style="border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin-top: 12px; background: #f9f9f9;">`;
        content += `<a href="${escapeHtml(post.url)}" style="color: #0066cc; word-break: break-all;">${escapeHtml(post.url)}</a>`;
        content += `</div>`;
      }

      // Truncate very long content
      if (content.length > 10000) {
        content = content.substring(0, 10000) + `<p><a href="${post.permalink}">... read more on Reddit</a></p>`;
      }

      digestPosts.push({
        postId: post.id,
        title: `r/${post.subreddit}: ${post.title}`,
        content: content || `<p><a href="${post.permalink}">View on Reddit</a></p>`,
        url: post.permalink,
        author: `u/${post.author}`,
        publishedAt: new Date(post.createdUtc * 1000),
        rawJson: post,
        metadata: {
          score: post.score,
          subreddit: post.subreddit,
          comments: post.numComments,
        },
      });
    }

    logger.info(`Reddit poll complete: found ${digestPosts.length} posts`);
    return digestPosts;
  } catch (err) {
    logger.error('Reddit polling failed:', err);
    throw err;
  }
}
