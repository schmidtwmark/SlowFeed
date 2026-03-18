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

function buildFeed(items: DigestItemRow[], format: 'rss' | 'atom', baseUrl: string): string {
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

    feed.addItem({
      title: `${sourceBadge} ${item.title}`,
      id: item.id,
      link: `${baseUrl}/digest/${item.id}`,
      content: item.content ?? undefined,
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
  const handleRssFeed = async (req: import('express').Request, res: import('express').Response) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const items = await getDigestItems(source);
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(items, 'rss', baseUrl);

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
      const items = await getDigestItems(source);
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
