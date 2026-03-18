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
 * - Removes inline styles
 * - Converts iframes to links
 * - Keeps only basic HTML tags
 */
function simplifyHtml(html: string): string {
  return html
    // Convert YouTube iframes to links
    .replace(/<iframe[^>]*src="https:\/\/www\.youtube\.com\/embed\/([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi,
      '<p><a href="https://www.youtube.com/watch?v=$1">▶ Watch on YouTube</a></p>')
    // Convert video tags to links
    .replace(/<video[^>]*>[\s\S]*?<source[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/video>/gi,
      '<p><a href="$1">▶ View Video</a></p>')
    // Remove inline styles
    .replace(/\s*style="[^"]*"/gi, '')
    // Remove class attributes
    .replace(/\s*class="[^"]*"/gi, '')
    // Simplify divs to paragraphs
    .replace(/<div[^>]*>/gi, '<p>')
    .replace(/<\/div>/gi, '</p>')
    // Remove empty paragraphs
    .replace(/<p>\s*<\/p>/gi, '')
    // Clean up multiple newlines
    .replace(/(<\/p>\s*)+/g, '</p>\n');
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

  // RSS feed - support both .rss and .xml extensions
  // Use ?simple=true for simplified HTML (better compatibility with some readers)
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

  router.get('/feed.rss', handleRssFeed);
  router.get('/feed.xml', handleRssFeed);
  router.get('/rss.xml', handleRssFeed);

  router.get('/feed.atom', async (req, res) => {
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
