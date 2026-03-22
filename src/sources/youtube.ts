import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  channelUrl: string;
  channelIcon: string;
  thumbnail: string;
  duration: string;
  publishedText: string;
  viewCount: string;
  url: string;
}

/**
 * Parse Netscape cookies.txt format to HTTP Cookie header format
 * Netscape format: domain\tflag\tpath\tsecure\texpiry\tname\tvalue
 * Also handles space-separated format (tabs sometimes get converted to spaces in textareas)
 */
function parseNetscapeCookies(cookiesTxt: string): string {
  const lines = cookiesTxt.split('\n');
  const cookies: string[] = [];

  for (const line of lines) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Try tab-separated first, then fall back to whitespace-separated
    let parts = trimmed.split('\t');
    if (parts.length < 7) {
      // Try splitting on multiple spaces/whitespace
      parts = trimmed.split(/\s+/);
    }

    if (parts.length >= 7) {
      const domain = parts[0];
      const name = parts[5];
      const value = parts[6];

      // Only include cookies for youtube.com and google.com domains
      if (name && value && (domain.includes('youtube.com') || domain.includes('google.com'))) {
        cookies.push(`${name}=${value}`);
      }
    }
  }

  logger.debug(`Parsed ${cookies.length} YouTube/Google cookies from Netscape format`);
  return cookies.join('; ');
}

/**
 * Detect if cookie string is Netscape format or already HTTP header format
 */
function isNetscapeFormat(cookies: string): boolean {
  // Netscape format has multiple lines with domain patterns like .youtube.com
  // HTTP header format is a single line with semicolon-separated name=value pairs
  const hasMultipleLines = cookies.includes('\n');
  const hasDomainPattern = /^\s*\.?(youtube|google)\.com\s/m.test(cookies);
  const looksLikeHeader = cookies.includes(';') && !hasMultipleLines;

  return (hasMultipleLines && hasDomainPattern) || (!looksLikeHeader && hasDomainPattern);
}

function getYouTubeCookies(): string {
  try {
    const config = getConfig();
    const cookies = config.youtube_cookies;
    if (!cookies) return '';

    // Auto-detect format and convert if needed
    if (isNetscapeFormat(cookies)) {
      return parseNetscapeCookies(cookies);
    }

    return cookies;
  } catch {
    return '';
  }
}

async function fetchPage(url: string): Promise<string> {
  const cookies = getYouTubeCookies();

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

function extractVideos(html: string): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];

  // YouTube embeds video data in a JSON object within the page
  // Look for ytInitialData which contains all the video information
  // Try multiple patterns as YouTube's format can vary
  let ytDataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/s);
  if (!ytDataMatch) {
    ytDataMatch = html.match(/ytInitialData\s*=\s*({.*?});/s);
  }
  if (!ytDataMatch) {
    // Try a more greedy match
    ytDataMatch = html.match(/var ytInitialData = (\{.+?\});\s*<\/script>/s);
  }
  if (!ytDataMatch) {
    // Try window["ytInitialData"] format
    ytDataMatch = html.match(/window\["ytInitialData"\]\s*=\s*(\{.+?\});/s);
  }

  if (!ytDataMatch) {
    logger.warn('Could not find ytInitialData in YouTube page');
    // Fallback: try to extract from HTML directly
    return extractVideosFromHtml(html);
  }

  try {
    const ytData = JSON.parse(ytDataMatch[1]);

    // Navigate to the video list in the JSON structure
    // The structure varies but videos are usually in tabs[0].tabRenderer.content
    const tabs = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];

    for (const tab of tabs) {
      const tabContent = tab?.tabRenderer?.content;
      if (!tabContent) continue;

      // Look for richGridRenderer which contains the videos
      const richGrid = tabContent?.richGridRenderer;
      if (!richGrid) continue;

      const contents = richGrid?.contents || [];

      // Flatten nested structures - YouTube now wraps videos in richSectionRenderer
      const flattenedItems: unknown[] = [];
      for (const item of contents) {
        if (item?.richItemRenderer) {
          flattenedItems.push(item);
        } else if (item?.richSectionRenderer) {
          // Videos are nested inside richSectionRenderer.content.richShelfRenderer.contents
          const sectionContents = item.richSectionRenderer?.content?.richShelfRenderer?.contents || [];
          flattenedItems.push(...sectionContents);
        }
      }

      for (const item of flattenedItems) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const typedItem = item as any;

        // Try multiple possible structures including the new lockupViewModel
        const content = typedItem?.richItemRenderer?.content;
        const videoRenderer = content?.videoRenderer ||
                              content?.reelItemRenderer ||
                              typedItem?.videoRenderer ||
                              typedItem?.gridVideoRenderer ||
                              typedItem?.compactVideoRenderer ||
                              typedItem?.reelItemRenderer;

        // Handle new lockupViewModel structure
        const lockupViewModel = content?.lockupViewModel;
        if (lockupViewModel) {
          const videoId = lockupViewModel.contentId;
          if (!videoId) continue;

          // Extract from lockupViewModel structure
          const lockupMetadata = lockupViewModel.metadata?.lockupMetadataViewModel;
          const title = lockupMetadata?.title?.content || 'Unknown Title';

          // Channel name is in metadata.contentMetadataViewModel.metadataRows[0].metadataParts[0].text.content
          const contentMetadata = lockupMetadata?.metadata?.contentMetadataViewModel;
          const firstRow = contentMetadata?.metadataRows?.[0];
          const channelName = firstRow?.metadataParts?.[0]?.text?.content || 'Unknown Channel';

          // Get thumbnail from contentImage.thumbnailViewModel or collectionThumbnailViewModel
          const thumbnailUrl = lockupViewModel.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url ||
                               lockupViewModel.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url ||
                               `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

          videos.push({
            id: videoId,
            title,
            channel: channelName,
            channelUrl: '',
            channelIcon: '',
            thumbnail: thumbnailUrl,
            duration: '',
            publishedText: '',
            viewCount: '',
            url: `https://www.youtube.com/watch?v=${videoId}`,
          });
          continue;
        }

        if (!videoRenderer) continue;

        const videoId = videoRenderer.videoId;
        if (!videoId) continue;

        // Extract video details
        const title = videoRenderer.title?.runs?.[0]?.text ||
                     videoRenderer.title?.simpleText ||
                     'Unknown Title';

        const channel = videoRenderer.ownerText?.runs?.[0]?.text ||
                       videoRenderer.shortBylineText?.runs?.[0]?.text ||
                       'Unknown Channel';

        const channelUrl = videoRenderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                          videoRenderer.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl ||
                          '';

        const thumbnail = videoRenderer.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '';

        const duration = videoRenderer.lengthText?.simpleText || '';

        const publishedText = videoRenderer.publishedTimeText?.simpleText ||
                             videoRenderer.publishedTimeText?.runs?.[0]?.text ||
                             '';

        const viewCount = videoRenderer.viewCountText?.simpleText ||
                         videoRenderer.viewCountText?.runs?.[0]?.text ||
                         '';

        // Channel icon from channelThumbnailSupportedRenderers or channelThumbnail
        const channelIcon =
          videoRenderer.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails?.[0]?.url ||
          videoRenderer.channelThumbnail?.thumbnails?.[0]?.url ||
          '';

        videos.push({
          id: videoId,
          title,
          channel,
          channelUrl: channelUrl ? `https://www.youtube.com${channelUrl}` : '',
          channelIcon,
          thumbnail,
          duration,
          publishedText,
          viewCount,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }
    }
  } catch (err) {
    logger.error('Failed to parse ytInitialData:', err);
    return extractVideosFromHtml(html);
  }

  return videos;
}

function extractVideosFromHtml(html: string): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];

  // Fallback HTML parsing for video IDs
  const videoIdRegex = /watch\?v=([a-zA-Z0-9_-]{11})/g;
  const seenIds = new Set<string>();

  let match;
  while ((match = videoIdRegex.exec(html)) !== null) {
    const videoId = match[1];
    if (seenIds.has(videoId)) continue;
    seenIds.add(videoId);

    // Try to find title near this video ID
    const context = html.substring(Math.max(0, match.index - 500), match.index + 500);

    // Look for title in aria-label or title attribute
    const titleMatch = context.match(/title="([^"]+)"/) ||
                       context.match(/aria-label="([^"]+)"/);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : `Video ${videoId}`;

    videos.push({
      id: videoId,
      title,
      channel: 'Unknown',
      channelUrl: '',
      channelIcon: '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: '',
      publishedText: '',
      viewCount: '',
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });

    // Limit fallback extraction
    if (videos.length >= 50) break;
  }

  return videos;
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
    .replace(/&#x2F;/g, '/');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function pollYouTube(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.youtube_enabled) {
    logger.debug('YouTube polling disabled');
    return [];
  }

  const cookies = await getYouTubeCookies();

  if (!cookies) {
    logger.warn('YouTube cookies not configured - cannot access subscriptions feed');
    return [];
  }

  logger.info('Polling YouTube subscriptions...');

  try {
    // Fetch the subscriptions feed
    const html = await fetchPage('https://www.youtube.com/feed/subscriptions');

    // Check if we're actually logged in
    const hasSignIn = html.includes('>Sign in<');
    const hasAvatar = html.includes('avatar-btn') || html.includes('yt-img-shadow');
    if (hasSignIn && !hasAvatar) {
      logger.warn('YouTube cookies may be invalid - page appears to show logged out state');
    }

    const videos = extractVideos(html);
    logger.info(`Found ${videos.length} videos in YouTube subscriptions`);

    if (videos.length === 0) {
      logger.warn('No videos found - check if cookies are valid');
    }

    const digestPosts: DigestPost[] = [];

    for (const video of videos) {
      // Build content
      let content = '';

      if (video.thumbnail) {
        content += `<p><a href="${escapeHtml(video.url)}"><img src="${escapeHtml(video.thumbnail)}" alt="Thumbnail" style="max-width: 480px;"></a></p>`;
      }

      const meta: string[] = [];
      if (video.duration) meta.push(video.duration);
      if (video.viewCount) meta.push(video.viewCount);
      if (video.publishedText) meta.push(video.publishedText);

      if (meta.length > 0) {
        content += `<p>${escapeHtml(meta.join(' • '))}</p>`;
      }

      if (video.channelUrl) {
        content += `<p>Channel: <a href="${escapeHtml(video.channelUrl)}">${escapeHtml(video.channel)}</a></p>`;
      }

      digestPosts.push({
        postId: video.id,
        title: video.title,
        content,
        url: video.url,
        author: video.channel,
        publishedAt: new Date(), // YouTube doesn't give exact timestamps in the HTML
        rawJson: video,
        metadata: {
          avatarUrl: video.channelIcon || undefined,
          channel: video.channel,
          duration: video.duration,
          thumbnail: video.thumbnail,
        },
      });
    }

    logger.info(`YouTube poll complete: found ${digestPosts.length} videos`);
    return digestPosts;
  } catch (err) {
    logger.error('YouTube polling failed:', err);
    throw err;
  }
}

// No OAuth needed - we use cookies
export function initYouTubeState(): Promise<void> {
  return Promise.resolve();
}
