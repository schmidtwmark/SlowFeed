import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia, PostLink } from '../types/index.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

interface RedditPost {
  id: string;
  title: string;
  author: string;
  subreddit: string;
  url: string;
  permalink: string;
  /** HTML-formatted selftext scraped from the listing expando, or `''` for
   *  non-self posts. The poll loop uses this as a fallback when the per-post
   *  `.json` fetch fails or returns no `selftext_html`. */
  selftextHtml: string;
  score: number;
  /** `null` when old.reddit didn't expose a count on the thing; the JSON pass
   *  fills this in when available. */
  numComments: number | null;
  createdUtc: number;
  thumbnail: string | null;
  isSelf: boolean;
  isImage: boolean;
  isVideo: boolean;
  isGallery: boolean;
  previewUrl: string | null;
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
    const timestampMatch = openingTag.match(/data-timestamp="([^"]+)"/);
    const commentsMatch = openingTag.match(/data-comments-count="([^"]+)"/);

    if (!idMatch) continue;

    const id = idMatch[1];
    const subreddit = subredditMatch ? subredditMatch[1] : 'unknown';
    const author = authorMatch ? authorMatch[1] : 'unknown';
    const postUrl = urlMatch ? urlMatch[1] : '';
    const permalink = permalinkMatch ? permalinkMatch[1] : `/r/${subreddit}/comments/${id}`;
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) || 0 : 0;
    const timestamp = timestampMatch ? parseInt(timestampMatch[1], 10) : Date.now();
    const numComments = commentsMatch ? parseInt(commentsMatch[1], 10) : null;

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

    // Extract selftext for self posts. old.reddit.com inlines the rendered
    // post body in the expando's `data-cachedhtml` attribute (double-encoded:
    // HTML-entity-escaped). We decode once to recover the real HTML; the poll
    // loop runs it through `stripHtmlToPlainText` later.
    let selftextHtml = '';
    if (isSelf) {
      const expandoMatch = thingBlock.match(/<div[^>]*class="[^"]*\bexpando\b[^"]*"[^>]*\bdata-cachedhtml="([^"]*)"/i);
      if (expandoMatch && expandoMatch[1]) {
        selftextHtml = decodeHtmlEntities(expandoMatch[1]);
      }
    }

    // For imgur single images, convert to direct image URL
    let finalUrl = postUrl.startsWith('/') ? `https://reddit.com${postUrl}` : postUrl;
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
      permalink: `https://reddit.com${permalink}`,
      selftextHtml,
      score,
      numComments: Number.isFinite(numComments) ? numComments : null,
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

interface RedditPostJson {
  selftextHtml: string;
  galleryImageUrls: string[];
  /** Per-image captions from media_metadata, parallel to galleryImageUrls. */
  galleryCaptions: (string | null)[];
  videoUrl: string | null;
  videoAudioUrl: string | null;
  previewUrl: string | null;
  /** `null` when the JSON didn't include it; otherwise an authoritative count. */
  numComments: number | null;
}

/**
 * Try a list of audio URL candidates derived from the video's fallback_url.
 * v.redd.it has used several suffixes over the years — DASH_AUDIO_128/64,
 * CMAF_AUDIO_128/64, and the legacy DASH_audio.mp4 — so we HEAD-probe each.
 * Returns the first URL that responds 200, or null if none do.
 */
async function resolveRedditAudioUrl(
  videoUrl: string,
  dashUrl: string | undefined,
): Promise<string | null> {
  const candidates: string[] = [];
  const pushSub = (pattern: RegExp, replacements: string[]) => {
    if (!pattern.test(videoUrl)) return;
    for (const r of replacements) {
      const withExt = videoUrl.replace(pattern, `${r}.mp4`);
      const noExt = videoUrl.replace(new RegExp(pattern.source.replace('\\.mp4', '') + '(?=\\?|$)'), r);
      if (!candidates.includes(withExt)) candidates.push(withExt);
      if (!candidates.includes(noExt) && noExt !== withExt) candidates.push(noExt);
    }
  };
  // DASH format: DASH_720.mp4 → DASH_AUDIO_128.mp4 / DASH_AUDIO_64.mp4 / DASH_audio.mp4
  pushSub(/DASH_\d+\.mp4/, ['DASH_AUDIO_128', 'DASH_AUDIO_64', 'DASH_audio']);
  // CMAF format: CMAF_720.mp4 → CMAF_AUDIO_128.mp4 / CMAF_AUDIO_64.mp4
  pushSub(/CMAF_\d+\.mp4/, ['CMAF_AUDIO_128', 'CMAF_AUDIO_64']);

  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) return url;
    } catch {
      // network error – try next
    }
  }

  // Fallback: parse the DASH manifest for an AdaptationSet with mimeType="audio/*"
  if (dashUrl) {
    try {
      const res = await fetch(dashUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) {
        const mpd = await res.text();
        // Extract the audio representation's BaseURL; pick the highest bandwidth.
        const audioSet = mpd.match(/<AdaptationSet[^>]*mimeType="audio\/[^"]+"[\s\S]*?<\/AdaptationSet>/i);
        if (audioSet) {
          const baseMatches = [...audioSet[0].matchAll(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi)];
          if (baseMatches.length > 0) {
            const base = baseMatches[baseMatches.length - 1][1].trim();
            const absolute = new URL(base, dashUrl).toString();
            const probe = await fetch(absolute, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
            if (probe.ok) return absolute;
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return null;
}

async function fetchPostJson(permalink: string): Promise<RedditPostJson | null> {
  // Route the JSON fetch through old.reddit.com — www/new.reddit.com sometimes
  // 403s scrapers that lack a bearer token while old.reddit serves the same
  // `.json` endpoint without auth.
  const jsonUrl = permalink
    .replace('https://reddit.com/', 'https://old.reddit.com/')
    .replace('https://www.reddit.com/', 'https://old.reddit.com/')
    + '.json';

  try {
    const cookies = getRedditCookies();

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    };
    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const response = await fetch(jsonUrl, { headers });
    if (!response.ok) {
      logger.debug(`Reddit post JSON fetch failed: ${response.status} ${jsonUrl}`);
      return null;
    }

    const json = await response.json() as Array<{
      data: {
        children: Array<{
          data: {
            selftext_html?: string;
            selftext?: string;
            thumbnail?: string;
            num_comments?: number;
            preview?: {
              images?: Array<{
                source?: { url?: string; width?: number; height?: number };
                resolutions?: Array<{ url?: string; width?: number; height?: number }>;
              }>;
            };
            media_metadata?: Record<string, {
              status: string;
              s?: { u?: string; gif?: string };
              caption?: string;
            }>;
            gallery_data?: { items: Array<{ media_id: string }> };
            media?: {
              reddit_video?: {
                fallback_url?: string;
                dash_url?: string;
                is_gif?: boolean;
              };
            };
            secure_media?: {
              reddit_video?: {
                fallback_url?: string;
                dash_url?: string;
                is_gif?: boolean;
              };
            };
            crosspost_parent_list?: Array<{
              media?: {
                reddit_video?: {
                  fallback_url?: string;
                  dash_url?: string;
                  is_gif?: boolean;
                };
              };
              secure_media?: {
                reddit_video?: {
                  fallback_url?: string;
                  dash_url?: string;
                  is_gif?: boolean;
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
                caption?: string;
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

    // Extract gallery images + per-image captions (Reddit stores these in
    // media_metadata[id].caption — previously dropped on the floor).
    const galleryImageUrls: string[] = [];
    const galleryCaptions: (string | null)[] = [];
    const mediaMetadata = postData.media_metadata || crosspost?.media_metadata;
    const galleryData = postData.gallery_data || crosspost?.gallery_data;

    const pushGallery = (url: string, caption: string | undefined) => {
      galleryImageUrls.push(url.replace(/&amp;/g, '&'));
      const c = caption?.trim();
      galleryCaptions.push(c && c.length > 0 ? c : null);
    };

    if (mediaMetadata && galleryData) {
      // Use gallery_data.items for ordering
      for (const item of galleryData.items) {
        const meta = mediaMetadata[item.media_id];
        if (meta?.status === 'valid' && meta.s) {
          const url = meta.s.gif || meta.s.u;
          if (url) pushGallery(url, meta.caption);
        }
      }
    } else if (mediaMetadata) {
      // No gallery_data ordering, just iterate
      for (const meta of Object.values(mediaMetadata)) {
        if (meta?.status === 'valid' && meta.s) {
          const url = meta.s.gif || meta.s.u;
          if (url) pushGallery(url, meta.caption);
        }
      }
    }

    // Extract video URL. v.redd.it serves video-only DASH/CMAF streams with
    // audio as a separate file. We probe a few known audio variants to find
    // one that exists (Reddit uses different suffixes at different times).
    let videoUrl: string | null = null;
    let videoAudioUrl: string | null = null;
    const redditVideo = postData.media?.reddit_video
      || postData.secure_media?.reddit_video
      || crosspost?.media?.reddit_video
      || crosspost?.secure_media?.reddit_video;

    if (redditVideo?.fallback_url) {
      videoUrl = redditVideo.fallback_url;
      const isGif = redditVideo.is_gif === true;
      if (!isGif) {
        videoAudioUrl = await resolveRedditAudioUrl(videoUrl, redditVideo.dash_url);
      }
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

    const numComments = typeof postData.num_comments === 'number' ? postData.num_comments : null;

    return { selftextHtml, galleryImageUrls, galleryCaptions, videoUrl, videoAudioUrl, previewUrl, numComments };
  } catch (err) {
    logger.debug(`Failed to fetch post JSON from ${jsonUrl}: ${(err as Error).message}`);
    return null;
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

/**
 * Pull inline images out of a self-post's rendered selftext HTML. Reddit
 * inlines images as `<img>` or `<a href=".../image.jpg">` — we stripHtml
 * later, so images would otherwise vanish from the post body.
 */
function extractImagesFromSelftext(html: string): PostMedia[] {
  const found: PostMedia[] = [];
  const seen = new Set<string>();

  const imgRe = /<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  for (const m of html.matchAll(imgRe)) {
    const src = (m[1] ?? m[2])?.replace(/&amp;/g, '&');
    if (src && !seen.has(src)) {
      seen.add(src);
      found.push({ type: 'image', url: src });
    }
  }

  // Reddit also commonly produces `<a href="https://i.redd.it/xxx.jpg">...</a>`
  // with no <img>. Pick those up too.
  const aRe = /<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  for (const m of html.matchAll(aRe)) {
    const href = (m[1] ?? m[2])?.replace(/&amp;/g, '&');
    if (!href) continue;
    if (!/\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(href)) continue;
    if (!seen.has(href)) {
      seen.add(href);
      found.push({ type: 'image', url: href });
    }
  }

  return found;
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
      let content = '';

      // Fetch JSON data for rich content (galleries, videos, selftext)
      const postJson = await fetchPostJson(post.permalink);

      // Gallery posts: each image becomes a media entry. Use Reddit's per-image
      // caption from media_metadata if present; fall back to a positional label.
      if (post.isGallery && postJson && postJson.galleryImageUrls.length > 0) {
        for (let i = 0; i < postJson.galleryImageUrls.length; i++) {
          const caption = postJson.galleryCaptions[i];
          media.push({
            type: 'image',
            url: postJson.galleryImageUrls[i],
            alt: caption ?? `${post.title} (${i + 1}/${postJson.galleryImageUrls.length})`,
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

      // Selftext: extract embedded images first (before we strip HTML) so that
      // a self/text post with inline images surfaces both text AND media.
      //
      // Source preference: the per-post `.json` response when it came back,
      // else the `data-cachedhtml` attribute we scraped from the listing. The
      // fallback is important for self posts when Reddit 403s our JSON
      // requests — without it, text posts arrive with title-only.
      const selftextHtmlRaw = postJson?.selftextHtml || post.selftextHtml;
      if (selftextHtmlRaw) {
        const decoded = decodeHtmlEntities(selftextHtmlRaw);
        const inlineImages = extractImagesFromSelftext(decoded);
        const existingUrls = new Set(media.map(m => m.url));
        for (const img of inlineImages) {
          if (!existingUrls.has(img.url)) {
            media.push(img);
            existingUrls.add(img.url);
          }
        }

        let plainText = stripHtmlToPlainText(decoded);
        if (plainText.length > 2000) {
          const truncateAt = plainText.lastIndexOf('.', 1800);
          const cutPoint = truncateAt > 1000 ? truncateAt + 1 : 1800;
          plainText = plainText.substring(0, cutPoint) + '...';
        }
        content = plainText;
      }

      // Small delay to avoid rate limiting on JSON fetch
      await new Promise(resolve => setTimeout(resolve, 300));

      // Non-self link posts: add to links array
      if (!post.isSelf && !post.isImage && !post.isVideo && !post.isGallery && post.url) {
        const previewImageUrl = postJson?.previewUrl || post.previewUrl;
        links.push({
          url: post.url,
          title: post.title,
          imageUrl: previewImageUrl || undefined,
        });
      }

      // Comment count: prefer the authoritative `.json` value when present,
      // fall back to the HTML `data-comments-count` attribute, else omit.
      const commentCount = postJson?.numComments ?? post.numComments ?? undefined;

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
          ...(typeof commentCount === 'number' ? { numComments: commentCount } : {}),
        },
        ...(media.length > 0 ? { media } : {}),
        ...(links.length > 0 ? { links } : {}),
      });
    }

    logger.info(`Reddit poll complete: found ${digestPosts.length} posts`);
    return digestPosts;
  } catch (err) {
    logger.error('Reddit polling failed:', err);
    throw err;
  }
}
