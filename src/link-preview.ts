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
 *  often serve `&amp;` for query separators). */
function decodeHTMLEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
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
