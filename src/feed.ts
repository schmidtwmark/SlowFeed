import { Router } from 'express';
import { Feed } from 'feed';
import { query } from './db.js';
import { getConfig } from './config.js';

interface DigestItemRow {
  id: string;
  source: string;
  title: string;
  content: string;
  published_at: Date;
}

async function getDigestItems(source?: string): Promise<DigestItemRow[]> {
  let sql = `
    SELECT id, source, title, content, published_at
    FROM digest_items
  `;
  const params: string[] = [];

  if (source) {
    sql += ' WHERE source = $1';
    params.push(source);
  }

  // Sort by published_at descending
  sql += `
    ORDER BY published_at DESC
    LIMIT 500
  `;

  const { rows } = await query<DigestItemRow>(sql, params);
  return rows;
}

/**
 * Strip HTML to plain text for description field
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Simplify HTML for better RSS reader compatibility
 * Keeps images and links clickable, removes complex styling
 * Ensures output is valid XML for RSS feeds
 */
function simplifyHtml(html: string): string {
  let result = html
    // Convert YouTube iframes to clickable links
    .replace(/<iframe[^>]*src="https:\/\/www\.youtube\.com\/embed\/([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi,
      '<p><a href="https://www.youtube.com/watch?v=$1">▶ Watch Video</a></p>')
    // Convert video tags to links
    .replace(/<video[^>]*>[\s\S]*?<source[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/video>/gi,
      '<p><a href="$1">▶ Watch Video</a></p>')
    // Remove style and script tags entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Simplify images - extract just src and alt, ensure self-closing
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '<img src="$1" alt="$2" />')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, '<img src="$2" alt="$1" />')
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '<img src="$1" alt="" />')
    // Add separator before border-styled divs (post wrappers)
    .replace(/<div[^>]*style="[^"]*border[^"]*"[^>]*>/gi, '<hr />')
    // Remove blockquote styles but keep the element
    .replace(/<blockquote[^>]*>/gi, '<blockquote>')
    // Remove div styles and simplify
    .replace(/<div[^>]*>/gi, '<div>')
    // Remove paragraph styles
    .replace(/<p[^>]*>/gi, '<p>')
    // Simplify links - extract just href
    .replace(/<a[^>]*href="([^"]*)"[^>]*>/gi, '<a href="$1">')
    // Remove spans entirely (usually just styling wrappers)
    .replace(/<\/?span[^>]*>/gi, '')
    // Ensure br tags are self-closing for XML
    .replace(/<br\s*\/?>/gi, '<br />')
    // Ensure hr tags are self-closing for XML
    .replace(/<hr\s*\/?>/gi, '<hr />')
    // Clean up empty paragraphs
    .replace(/<p>\s*<\/p>/gi, '')
    // Clean up empty divs
    .replace(/<div>\s*<\/div>/gi, '')
    // Remove leading separator (first post doesn't need one)
    .replace(/^(\s*<br \/>\s*)*<hr \/>/i, '')
    // Remove trailing separators
    .replace(/(<hr \/>\s*(<br \/>)*\s*)+$/i, '')
    // Fix any unescaped ampersands in URLs (but not already-escaped ones)
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');

  return result;
}

function buildFeed(items: DigestItemRow[], format: 'rss' | 'atom', baseUrl: string, simple = false): string {
  const config = getConfig();

  const feed = new Feed({
    title: config.feed_title,
    description: 'Aggregated feed from Reddit, Bluesky, YouTube, and Discord',
    id: 'slowfeed',
    link: baseUrl,
    language: 'en',
    updated: new Date(),
    generator: 'Slowfeed',
    copyright: '',
  });

  for (const item of items) {
    const sourceBadge = `[${item.source}]`;
    const content = item.content ?? '';
    const processedContent = simple ? simplifyHtml(content) : content;
    const description = stripHtml(content).substring(0, 300) + (content.length > 300 ? '...' : '');

    feed.addItem({
      title: `${sourceBadge} ${item.title}`,
      id: item.id,
      link: `${baseUrl}/digest/${item.id}`,
      description: description,
      content: processedContent || undefined,
      date: new Date(item.published_at),
    });
  }

  return format === 'atom' ? feed.atom1() : feed.rss2();
}

export function createFeedRouter(): Router {
  const router = Router();

  // Helper to get base URL from request
  const getBaseUrl = (req: import('express').Request): string => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${protocol}://${host}`;
  };

  // Middleware to validate feed token
  const validateToken = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    const config = getConfig();
    const expectedToken = config.feed_token;

    // If no token is configured, allow access (backwards compatibility)
    if (!expectedToken) {
      return next();
    }

    const providedToken = req.query.token;

    if (providedToken !== expectedToken) {
      res.status(401).send('Unauthorized - invalid or missing token');
      return;
    }

    next();
  };

  // RSS feed - support both .rss and .xml extensions
  // Use ?simple=true for simplified HTML (better compatibility with some readers)
  // Use ?token=<secret> for authentication
  const handleRssFeed = async (req: import('express').Request, res: import('express').Response) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const simple = req.query.simple === 'true';
      const items = await getDigestItems(source);
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(items, 'rss', baseUrl, simple);

      res.set('Content-Type', 'application/rss+xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      console.error('Error generating RSS feed:', err);
      res.status(500).send('Error generating feed');
    }
  };

  router.get('/feed.rss', validateToken, handleRssFeed);
  router.get('/feed.xml', validateToken, handleRssFeed);
  router.get('/rss.xml', validateToken, handleRssFeed);

  router.get('/feed.atom', validateToken, async (req, res) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const simple = req.query.simple === 'true';
      const items = await getDigestItems(source);
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(items, 'atom', baseUrl, simple);

      res.set('Content-Type', 'application/atom+xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      console.error('Error generating Atom feed:', err);
      res.status(500).send('Error generating feed');
    }
  });

  return router;
}
