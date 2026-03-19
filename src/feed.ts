import { Router } from 'express';
import { Feed } from 'feed';
import { query } from './db.js';
import { getConfig } from './config.js';

interface FeedItemRow {
  id: string;
  source: string;
  title: string;
  content: string | null;
  url: string;
  author: string | null;
  published_at: Date;
  is_notification: boolean;
}

async function getFeedItems(source?: string): Promise<FeedItemRow[]> {
  const config = getConfig();
  const ttlDays = config.feed_ttl_days ?? 14;

  let sql = `
    SELECT id, source, title, content, url, author, published_at, is_notification
    FROM feed_items
    WHERE created_at > NOW() - INTERVAL '1 day' * $1
  `;
  const params: (string | number)[] = [ttlDays];

  if (source) {
    sql += ' AND source = $2';
    params.push(source);
  }

  sql += `
    ORDER BY published_at DESC
    LIMIT 200
  `;

  const { rows } = await query<FeedItemRow>(sql, params);
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
 * Get a source label for feed item titles
 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'reddit': return 'Reddit';
    case 'bluesky': return 'Bluesky';
    case 'youtube': return 'YouTube';
    case 'discord': return 'Discord';
    default: return source;
  }
}

function buildFeed(items: FeedItemRow[], format: 'rss' | 'atom', baseUrl: string): string {
  const config = getConfig();

  const feed = new Feed({
    title: config.feed_title,
    description: 'Aggregated feed from Reddit, Bluesky, YouTube, and Discord',
    id: 'slowfeed',
    link: baseUrl,
    language: 'en',
    updated: items.length > 0 ? new Date(items[0].published_at) : new Date(),
    generator: 'Slowfeed',
    copyright: '',
  });

  for (const item of items) {
    const content = item.content ?? '';
    const plainText = stripHtml(content);
    const description = plainText.substring(0, 280) + (plainText.length > 280 ? '...' : '');

    feed.addItem({
      title: item.title,
      id: item.id,
      link: item.url,
      description: description,
      content: content || undefined,
      date: new Date(item.published_at),
      author: item.author ? [{ name: item.author }] : undefined,
      category: [{ name: sourceLabel(item.source) }],
    });
  }

  return format === 'atom' ? feed.atom1() : feed.rss2();
}

export function createFeedRouter(): Router {
  const router = Router();

  const getBaseUrl = (req: import('express').Request): string => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    return `${protocol}://${host}`;
  };

  const validateToken = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
    const config = getConfig();
    const expectedToken = config.feed_token;

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

  const handleRssFeed = async (req: import('express').Request, res: import('express').Response) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const items = await getFeedItems(source);
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(items, 'rss', baseUrl);

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
      const items = await getFeedItems(source);
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(items, 'atom', baseUrl);

      res.set('Content-Type', 'application/atom+xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      console.error('Error generating Atom feed:', err);
      res.status(500).send('Error generating feed');
    }
  });

  return router;
}
