import { logger } from './logger.js';

/**
 * Best-effort Open-Graph image extraction for URLs that the user might
 * paste as text. Specifically scoped to a small allowlist of services
 * (Tenor, Instagram) where a tappable thumbnail in the feed is clearly
 * an improvement over a bare hyperlink. We don't OG-scrape arbitrary
 * URLs because Reddit / Bluesky / Mastodon all already produce their
 * own embed cards for most links — adding a second card would just be
 * noise.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/** Match a Tenor "view" page (the canonical share URL Tenor exports). */
const TENOR_RE = /https?:\/\/(?:www\.)?tenor\.com\/view\/[^\s)<>"]+/gi;
/** Match Instagram post / reel / IGTV URLs. */
const INSTAGRAM_RE =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?(?:\?[^\s)<>"]*)?/gi;

const FETCH_TIMEOUT_MS = 4000;

/** Process-wide cache so the same URL isn't fetched multiple times in
 *  one poll run (the same Tenor link can show up across many posts).
 *  `null` means "we tried and there's nothing". */
const cache = new Map<string, string | null>();

export interface ResolvedLinkThumbnail {
  /** The URL the user saw in the post text. */
  pageUrl: string;
  /** Direct image URL (og:image or twitter:image). */
  imageUrl: string;
  /** Which scraping rule matched. */
  service: 'tenor' | 'instagram';
}

function extractOgImage(html: string): string | undefined {
  // Try multiple <meta> attribute orderings + fallbacks.
  const patterns: RegExp[] = [
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]*?content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i,
    /<meta[^>]+name\s*=\s*["']twitter:image["'][^>]*?content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+name\s*=\s*["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHTMLEntities(m[1]);
  }
  return undefined;
}

/** Minimal entity decoder for og:image URL values (Tenor and others
 *  often serve `&amp;` for query separators). `&amp;` goes last so
 *  `&amp;quot;` decodes to `&quot;`, not `"`. */
function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** First value of each `<meta property|name="…" content="…">` tag, keyed
 *  by lowercased property/name. */
function extractMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!key || !content || tags.has(key)) continue;
    tags.set(key, decodeHTMLEntities(content[1] ?? content[2]));
  }
  return tags;
}

async function fetchOgImage(url: string): Promise<string | undefined> {
  if (cache.has(url)) {
    const v = cache.get(url);
    return v === null ? undefined : v ?? undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      cache.set(url, null);
      return undefined;
    }
    // og:image is in <head>; reading the first chunk and stopping is enough
    // for most pages, but `res.text()` is simpler and the timeout caps it.
    const html = await res.text();
    const img = extractOgImage(html);
    cache.set(url, img ?? null);
    return img;
  } catch (err) {
    logger.debug(`Link preview fetch failed for ${url}: ${(err as Error).message}`);
    cache.set(url, null);
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Find every Tenor / Instagram URL in a chunk of free-form text and
 * resolve each to an og:image. Runs fetches in parallel and dedupes
 * URLs both within this call and across calls (via the module cache).
 */
export async function findLinkThumbnails(text: string): Promise<ResolvedLinkThumbnail[]> {
  const seen = new Set<string>();
  const work: Promise<ResolvedLinkThumbnail | null>[] = [];

  for (const m of text.matchAll(TENOR_RE)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    work.push(
      fetchOgImage(url).then(img => (img ? { pageUrl: url, imageUrl: img, service: 'tenor' } : null))
    );
  }
  for (const m of text.matchAll(INSTAGRAM_RE)) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    work.push(
      fetchOgImage(url).then(img => (img ? { pageUrl: url, imageUrl: img, service: 'instagram' } : null))
    );
  }

  const results = await Promise.all(work);
  return results.filter((r): r is ResolvedLinkThumbnail => r !== null);
}

/** Instagram (and its embed mirrors) serve Open Graph tags to bots but
 *  only a login shell to browser user-agents. */
const PREVIEW_BOT_USER_AGENT = 'Mozilla/5.0 (compatible; Slowfeed/1.0)';

export interface InstagramPreview {
  /** "Name (@handle)" */
  author?: string;
  caption?: string;
  imageUrl?: string;
  /** MP4 (or a redirect to one) for reels and video posts. */
  videoUrl?: string;
  /** Canonical instagram.com URL, when the page reports one. */
  url?: string;
  /** ISO 8601 */
  publishedAt?: string;
}

const instagramCache = new Map<string, InstagramPreview | null>();

/** Pull the caption out of og:description. instagram.com wraps it as
 *  `20K likes, 148 comments - user on October 21, 2026: "caption". `;
 *  embed mirrors prefix a stats line like `❤️ 439  💬 11`. */
function instagramCaption(description: string, siteName?: string): string | undefined {
  const quoted = siteName === 'Instagram' ? description.match(/: "([\s\S]*)"\.?\s*$/) : null;
  const caption = quoted
    ? quoted[1]
    : description.replace(/^(?=[^\n]*\d)[^\p{L}\n]*\n+/u, '');
  return caption.trim() || undefined;
}

function parseInstagramPreview(tags: Map<string, string>): InstagramPreview | null {
  // twitter:title is "Name (@handle)" (instagram.com appends " • Instagram
  // reel"); instagram.com's og:title is "Name on Instagram: <caption>".
  const title = tags.get('twitter:title') ?? tags.get('og:title');
  const description = tags.get('og:description');
  const published = new Date(tags.get('article:published_time') ?? tags.get('og:pubdate') ?? '');
  const preview: InstagramPreview = {
    author: title?.replace(/\s*•\s*Instagram\b.*$/, '') || undefined,
    caption: (description && instagramCaption(description, tags.get('og:site_name')))
      || tags.get('og:image:alt'),
    imageUrl: tags.get('og:image') ?? tags.get('twitter:image'),
    videoUrl: tags.get('og:video:secure_url') ?? tags.get('og:video'),
    url: tags.get('og:url'),
    // The client rejects the whole digest on an unparseable date.
    publishedAt: isNaN(published.getTime()) ? undefined : published.toISOString(),
  };
  return preview.caption || preview.imageUrl || preview.videoUrl ? preview : null;
}

/**
 * Author, caption, image and video for an Instagram post, read from the
 * Open Graph tags of `url` — an instagram.com link or an embed mirror
 * (oginstagram, ddinstagram, …). Cached per URL for the process.
 */
export async function fetchInstagramPreview(url: string): Promise<InstagramPreview | undefined> {
  if (instagramCache.has(url)) {
    return instagramCache.get(url) ?? undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let preview: InstagramPreview | null = null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': PREVIEW_BOT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    // Some mirrors (kkinstagram) answer bots with a redirect straight to
    // the MP4 — don't download it.
    if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
      preview = parseInstagramPreview(extractMetaTags(await res.text()));
    } else {
      await res.body?.cancel();
    }
  } catch (err) {
    logger.debug(`Instagram preview fetch failed for ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
  instagramCache.set(url, preview);
  return preview ?? undefined;
}
