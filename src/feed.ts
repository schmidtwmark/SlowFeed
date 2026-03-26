import { Router } from 'express';
import { Feed } from 'feed';
import { query } from './db.js';
import { getConfig } from './config.js';

interface PollRunRow {
  id: number;
  schedule_name: string | null;
  sources: string[];
  started_at: Date;
  status: string;
}

interface PollRunWithDigests extends PollRunRow {
  digest_count: number;
  total_posts: number;
}

async function getPollRuns(): Promise<PollRunWithDigests[]> {
  const sql = `
    SELECT
      pr.id,
      pr.schedule_name,
      pr.sources,
      pr.started_at,
      pr.status,
      COUNT(di.id)::integer as digest_count,
      COALESCE(SUM(di.post_count), 0)::integer as total_posts
    FROM poll_runs pr
    LEFT JOIN digest_items di ON di.poll_run_id = pr.id
    WHERE pr.status = 'completed'
    GROUP BY pr.id, pr.schedule_name, pr.sources, pr.started_at, pr.status
    HAVING COUNT(di.id) > 0
    ORDER BY pr.started_at DESC
    LIMIT 100
  `;

  const { rows } = await query<PollRunWithDigests>(sql, []);
  return rows;
}

function formatPollRunTitle(): string {
  // Just use a simple title - the RSS reader shows the date from metadata
  return 'SlowFeed Digest';
}

function buildFeed(runs: PollRunWithDigests[], format: 'rss' | 'atom', baseUrl: string): string {
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

  for (const run of runs) {
    const runUrl = `${baseUrl}/run/${run.id}`;
    const title = formatPollRunTitle();

    feed.addItem({
      title,
      id: `run-${run.id}`,
      link: runUrl,
      content: `<a href="${runUrl}">View ${run.total_posts} items from ${run.digest_count} source${run.digest_count === 1 ? '' : 's'}</a>`,
      date: new Date(run.started_at),
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
  // Use ?token=<secret> for authentication
  const handleRssFeed = async (req: import('express').Request, res: import('express').Response) => {
    try {
      const runs = await getPollRuns();
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(runs, 'rss', baseUrl);

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
      const runs = await getPollRuns();
      const baseUrl = getBaseUrl(req);
      const xml = buildFeed(runs, 'atom', baseUrl);

      res.set('Content-Type', 'application/atom+xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      console.error('Error generating Atom feed:', err);
      res.status(500).send('Error generating feed');
    }
  });

  return router;
}
