import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import { loadConfig, getConfig, setConfigValues, setConfigValue, generateFeedToken, Config } from '../config.js';
import { query } from '../db.js';
import { triggerMainPoll, triggerSourcePoll, triggerSchedulePoll, restartScheduler, getPollStatus, getScheduleStatus } from '../scheduler.js';
import { getAllSchedules, createSchedule, updateSchedule, deleteSchedule, validateScheduleInput, getNextRunTime } from '../schedules.js';
import { testBlueskyConnection, pollBluesky } from '../sources/bluesky.js';
import { testDiscordConnection, fetchGuilds, fetchChannels, pollDiscord } from '../sources/discord.js';
import { pollReddit } from '../sources/reddit.js';
import { pollYouTube } from '../sources/youtube.js';
import { logger, getLogs, clearLogs } from '../logger.js';
import type { ScheduleInput } from '../types/index.js';

// Simple session store (in production, use a proper session store)
const sessions = new Map<string, { authenticated: boolean; expires: number }>();

function generateSessionId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const sessionId = req.headers['x-session-id'] as string;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    if (session.authenticated && session.expires > Date.now()) {
      next();
      return;
    }
    sessions.delete(sessionId);
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export function createUiRouter(): Router {
  const router = Router();

  // Login endpoint
  router.post('/api/login', async (req, res) => {
    try {
      const { password } = req.body;
      const config = await loadConfig();

      // Simple password comparison (in production, hash the stored password)
      if (password === config.ui_password) {
        const sessionId = generateSessionId();
        sessions.set(sessionId, {
          authenticated: true,
          expires: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        });

        res.json({ sessionId });
      } else {
        res.status(401).json({ error: 'Invalid password' });
      }
    } catch (err) {
      logger.error('Login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Logout endpoint
  router.post('/api/logout', (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (sessionId) {
      sessions.delete(sessionId);
    }
    res.json({ success: true });
  });

  // Check auth status
  router.get('/api/auth/status', (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      if (session.authenticated && session.expires > Date.now()) {
        res.json({ authenticated: true });
        return;
      }
    }

    res.json({ authenticated: false });
  });

  // Protected routes below
  router.use('/api', authMiddleware);

  // Get configuration
  router.get('/api/config', async (_req, res) => {
    try {
      const config = await loadConfig();
      // Don't send passwords to the client (but keep feed_token visible)
      const safeConfig = {
        ...config,
        bluesky_app_password: config.bluesky_app_password ? '••••••••' : '',
        discord_token: config.discord_token ? '••••••••' : '',
        youtube_cookies: config.youtube_cookies ? '••••••••' : '',
        reddit_cookies: config.reddit_cookies ? '••••••••' : '',
        ui_password: '••••••••',
        // feed_token is intentionally NOT masked - users need to see it
      };
      res.json(safeConfig);
    } catch (err) {
      logger.error('Error fetching config:', err);
      res.status(500).json({ error: 'Failed to fetch config' });
    }
  });

  // Regenerate feed token
  router.post('/api/feed-token/regenerate', async (_req, res) => {
    try {
      const newToken = generateFeedToken();
      await setConfigValue('feed_token', newToken);
      res.json({ token: newToken });
    } catch (err) {
      logger.error('Error regenerating feed token:', err);
      res.status(500).json({ error: 'Failed to regenerate token' });
    }
  });

  // Update configuration
  router.post('/api/config', async (req, res) => {
    try {
      const updates: Partial<Config> = {};

      // Validate and sanitize inputs
      // Note: poll_interval_hours is deprecated, use poll_schedules instead
      const allowedKeys: (keyof Config)[] = [
        'bluesky_enabled',
        'bluesky_handle',
        'bluesky_app_password',
        'bluesky_top_n',
        'youtube_enabled',
        'youtube_cookies',
        'reddit_enabled',
        'reddit_cookies',
        'reddit_top_n',
        'reddit_include_comments',
        'reddit_comment_depth',
        'discord_enabled',
        'discord_token',
        'discord_channels',
        'discord_top_n',
        'feed_title',
        'feed_ttl_days',
        'ui_password',
      ];

      for (const key of allowedKeys) {
        if (key in req.body && req.body[key] !== '••••••••') {
          updates[key] = req.body[key];
        }
      }

      await setConfigValues(updates);
      await restartScheduler();

      res.json({ success: true });
    } catch (err) {
      logger.error('Error updating config:', err);
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  // Get dashboard stats - optimized with single query for counts
  router.get('/api/stats', async (_req, res) => {
    try {
      // Combined query: get source counts and total in one query using ROLLUP
      const { rows: countRows } = await query<{ source: string | null; count: string }>(
        `SELECT source, COUNT(*) as count FROM digest_items GROUP BY ROLLUP(source)`
      );

      // Parse counts - row with NULL source is the total
      const sourceCounts: Record<string, number> = {};
      let totalItems = 0;
      for (const row of countRows) {
        if (row.source === null) {
          totalItems = parseInt(row.count, 10);
        } else {
          sourceCounts[row.source] = parseInt(row.count, 10);
        }
      }

      // Get recent digests (without full content for speed)
      const { rows: recentItems } = await query<{
        id: string;
        source: string;
        title: string;
        post_count: number;
        published_at: Date;
      }>(
        `SELECT id, source, title, post_count, published_at
         FROM digest_items
         ORDER BY created_at DESC
         LIMIT 20`
      );

      res.json({
        sourceCounts,
        totalItems,
        recentItems,
      });
    } catch (err) {
      logger.error('Error fetching stats:', err);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // Get single digest content by ID (for lazy loading)
  router.get('/api/digest/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await query<{ content: string }>(
        `SELECT content FROM digest_items WHERE id = $1`,
        [id]
      );

      if (rows.length === 0) {
        res.status(404).json({ error: 'Digest not found' });
        return;
      }

      res.json({ content: rows[0].content });
    } catch (err) {
      logger.error('Error fetching digest:', err);
      res.status(500).json({ error: 'Failed to fetch digest' });
    }
  });

  // Get all digests with pagination
  router.get('/api/feed-items', async (req, res) => {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const source = req.query.source as string | undefined;
      const offset = (page - 1) * limit;

      let sql = `
        SELECT id, source, title, content, post_count, published_at
        FROM digest_items
      `;
      const params: (string | number)[] = [];

      if (source) {
        sql += ' WHERE source = $1';
        params.push(source);
      }

      sql += ` ORDER BY published_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const { rows } = await query(sql, params);

      // Get total count
      let countSql = 'SELECT COUNT(*) as count FROM digest_items';
      const countParams: string[] = [];
      if (source) {
        countSql += ' WHERE source = $1';
        countParams.push(source);
      }
      const { rows: countRows } = await query<{ count: string }>(countSql, countParams);

      res.json({
        items: rows,
        total: parseInt(countRows[0]?.count ?? '0', 10),
        page,
        limit,
      });
    } catch (err) {
      logger.error('Error fetching digests:', err);
      res.status(500).json({ error: 'Failed to fetch digests' });
    }
  });

  // Trigger manual poll
  router.post('/api/poll', async (req, res) => {
    try {
      const { source } = req.body;

      if (source && ['reddit', 'bluesky', 'youtube', 'discord'].includes(source)) {
        await triggerSourcePoll(source);
      } else {
        await triggerMainPoll();
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('Error triggering poll:', err);
      res.status(500).json({ error: 'Failed to trigger poll' });
    }
  });

  // OAuth status endpoints
  router.get('/api/oauth/status', async (_req, res) => {
    try {
      const { rows } = await query<{ service: string; expires_at: Date | null }>(
        'SELECT service, expires_at FROM oauth_tokens'
      );

      const status: Record<string, { connected: boolean; expiresAt: Date | null }> = {
        reddit: { connected: false, expiresAt: null },
        google: { connected: false, expiresAt: null },
      };

      for (const row of rows) {
        if (row.service in status) {
          status[row.service] = {
            connected: true,
            expiresAt: row.expires_at,
          };
        }
      }

      res.json(status);
    } catch (err) {
      logger.error('Error fetching OAuth status:', err);
      res.status(500).json({ error: 'Failed to fetch OAuth status' });
    }
  });

  // Get poll status for all sources
  router.get('/api/poll/status', (_req, res) => {
    const status = getPollStatus();
    const result: Record<string, unknown> = {};

    for (const [source, data] of status) {
      result[source] = {
        lastPoll: data.lastPoll?.toISOString() || null,
        lastError: data.lastError,
        isPolling: data.isPolling,
      };
    }

    res.json(result);
  });

  // Test Bluesky connection
  router.post('/api/bluesky/test', async (_req, res) => {
    try {
      const result = await testBlueskyConnection();
      res.json(result);
    } catch (err) {
      logger.error('Error testing Bluesky connection:', err);
      res.status(500).json({ success: false, error: 'Test failed' });
    }
  });

  // Test Discord connection
  router.post('/api/discord/test', async (_req, res) => {
    try {
      const result = await testDiscordConnection();
      res.json(result);
    } catch (err) {
      logger.error('Error testing Discord connection:', err);
      res.status(500).json({ success: false, error: 'Test failed' });
    }
  });

  // Get Discord guilds (servers)
  router.get('/api/discord/guilds', async (_req, res) => {
    try {
      const guilds = await fetchGuilds();
      res.json(guilds);
    } catch (err) {
      logger.error('Error fetching Discord guilds:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch guilds';
      res.status(500).json({ error: errorMessage });
    }
  });

  // Get Discord channels for a guild
  router.get('/api/discord/channels/:guildId', async (req, res) => {
    try {
      const { guildId } = req.params;
      const channels = await fetchChannels(guildId);
      res.json(channels);
    } catch (err) {
      logger.error('Error fetching Discord channels:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch channels';
      res.status(500).json({ error: errorMessage });
    }
  });

  // Get logs
  router.get('/api/logs', (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const logs = getLogs(limit);
    res.json(logs);
  });

  // Clear logs
  router.post('/api/logs/clear', (_req, res) => {
    clearLogs();
    logger.info('Logs cleared');
    res.json({ success: true });
  });

  // === Data Management Endpoints ===

  // Clear seen posts and digests for a specific source
  router.delete('/api/data/:source', async (req, res) => {
    try {
      const source = req.params.source;
      const validSources = ['reddit', 'bluesky', 'youtube', 'discord'];

      if (!validSources.includes(source)) {
        res.status(400).json({ error: 'Invalid source' });
        return;
      }

      // Delete digests for this source
      const digestResult = await query(
        'DELETE FROM digest_items WHERE source = $1',
        [source]
      );

      // Delete seen posts for this source
      const seenResult = await query(
        'DELETE FROM seen_posts WHERE source = $1',
        [source]
      );

      const digestsDeleted = digestResult.rowCount ?? 0;
      const postsDeleted = seenResult.rowCount ?? 0;

      logger.info(`Cleared ${source} data: ${digestsDeleted} digests, ${postsDeleted} seen posts`);

      res.json({
        success: true,
        digestsDeleted,
        postsDeleted,
      });
    } catch (err) {
      logger.error('Error clearing source data:', err);
      res.status(500).json({ error: 'Failed to clear data' });
    }
  });

  // Clear all data for all sources
  router.delete('/api/data', async (_req, res) => {
    try {
      const digestResult = await query('DELETE FROM digest_items');
      const seenResult = await query('DELETE FROM seen_posts');

      const digestsDeleted = digestResult.rowCount ?? 0;
      const postsDeleted = seenResult.rowCount ?? 0;

      logger.info(`Cleared all data: ${digestsDeleted} digests, ${postsDeleted} seen posts`);

      res.json({
        success: true,
        digestsDeleted,
        postsDeleted,
      });
    } catch (err) {
      logger.error('Error clearing all data:', err);
      res.status(500).json({ error: 'Failed to clear data' });
    }
  });

  // === Test Fetch Endpoints (fetch without deduplication) ===

  // Test fetch for any source
  router.post('/api/test/:source', async (req, res) => {
    const source = req.params.source;
    const validSources = ['reddit', 'bluesky', 'youtube', 'discord'];

    if (!validSources.includes(source)) {
      res.status(400).json({ error: 'Invalid source' });
      return;
    }

    try {
      let posts: Awaited<ReturnType<typeof pollReddit>> = [];
      switch (source) {
        case 'reddit':
          posts = await pollReddit();
          break;
        case 'bluesky':
          posts = await pollBluesky();
          break;
        case 'youtube':
          posts = await pollYouTube();
          break;
        case 'discord':
          posts = await pollDiscord();
          break;
      }

      res.json({
        success: true,
        source,
        count: posts.length,
        posts: posts.map(p => ({
          postId: p.postId,
          title: p.title,
          author: p.author,
          url: p.url,
          publishedAt: p.publishedAt,
          contentPreview: p.content.substring(0, 500) + (p.content.length > 500 ? '...' : ''),
        })),
      });
    } catch (err) {
      logger.error(`Error testing ${source}:`, err);
      const errorMessage = err instanceof Error ? err.message : 'Test fetch failed';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // === Schedule CRUD Endpoints ===

  // Get all schedules
  router.get('/api/schedules', async (_req, res) => {
    try {
      const schedules = await getAllSchedules();
      const scheduleStatusMap = getScheduleStatus();

      // Add status info to each schedule
      const schedulesWithStatus = schedules.map(schedule => ({
        ...schedule,
        nextRun: getNextRunTime(schedule)?.toISOString() || null,
        lastRun: scheduleStatusMap.get(schedule.id)?.lastRun?.toISOString() || null,
        isRunning: scheduleStatusMap.get(schedule.id)?.isRunning || false,
      }));

      res.json(schedulesWithStatus);
    } catch (err) {
      logger.error('Error fetching schedules:', err);
      res.status(500).json({ error: 'Failed to fetch schedules' });
    }
  });

  // Create a new schedule
  router.post('/api/schedules', async (req, res) => {
    try {
      const input: ScheduleInput = {
        name: req.body.name,
        days_of_week: req.body.days_of_week,
        time_of_day: req.body.time_of_day,
        timezone: req.body.timezone,
        sources: req.body.sources,
        enabled: req.body.enabled ?? true,
      };

      // Validate input
      const errors = validateScheduleInput(input);
      if (errors.length > 0) {
        res.status(400).json({ error: errors.join(', ') });
        return;
      }

      const schedule = await createSchedule(input);

      // Restart scheduler to pick up new schedule
      await restartScheduler();

      res.json(schedule);
    } catch (err) {
      logger.error('Error creating schedule:', err);
      res.status(500).json({ error: 'Failed to create schedule' });
    }
  });

  // Update a schedule
  router.put('/api/schedules/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid schedule ID' });
        return;
      }

      const input: Partial<ScheduleInput> = {};

      if (req.body.name !== undefined) input.name = req.body.name;
      if (req.body.days_of_week !== undefined) input.days_of_week = req.body.days_of_week;
      if (req.body.time_of_day !== undefined) input.time_of_day = req.body.time_of_day;
      if (req.body.timezone !== undefined) input.timezone = req.body.timezone;
      if (req.body.sources !== undefined) input.sources = req.body.sources;
      if (req.body.enabled !== undefined) input.enabled = req.body.enabled;

      const schedule = await updateSchedule(id, input);

      if (!schedule) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }

      // Restart scheduler to pick up changes
      await restartScheduler();

      res.json(schedule);
    } catch (err) {
      logger.error('Error updating schedule:', err);
      res.status(500).json({ error: 'Failed to update schedule' });
    }
  });

  // Delete a schedule
  router.delete('/api/schedules/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid schedule ID' });
        return;
      }

      const deleted = await deleteSchedule(id);

      if (!deleted) {
        res.status(404).json({ error: 'Schedule not found' });
        return;
      }

      // Restart scheduler to remove the schedule
      await restartScheduler();

      res.json({ success: true });
    } catch (err) {
      logger.error('Error deleting schedule:', err);
      res.status(500).json({ error: 'Failed to delete schedule' });
    }
  });

  // Manually run a schedule
  router.post('/api/schedules/:id/run', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid schedule ID' });
        return;
      }

      await triggerSchedulePoll(id);
      res.json({ success: true });
    } catch (err) {
      logger.error('Error running schedule:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to run schedule';
      res.status(500).json({ error: errorMessage });
    }
  });

  // Serve index.html for all UI routes (client-side routing)
  const uiRoutes = [
    '/dashboard',
    '/schedules',
    '/settings',
    '/settings/general',
    '/settings/bluesky',
    '/settings/youtube',
    '/settings/reddit',
    '/settings/discord',
    '/feed-preview',
    '/logs',
  ];

  for (const route of uiRoutes) {
    router.get(route, (_req, res) => {
      res.sendFile(path.join(process.cwd(), 'src/ui/public/index.html'));
    });
  }

  // Public digest view (linked from RSS feed items)
  router.get('/digest/:id', async (req, res) => {
    try {
      const { id } = req.params;

      const { rows } = await query<{
        id: string;
        source: string;
        title: string;
        content: string;
        published_at: Date;
      }>(
        'SELECT id, source, title, content, published_at FROM digest_items WHERE id = $1',
        [id]
      );

      if (rows.length === 0) {
        res.status(404).send('Digest not found');
        return;
      }

      const digest = rows[0];
      const content = digest.content || '';

      // Get previous and next digests for navigation
      const { rows: prevRows } = await query<{ id: string; title: string }>(
        `SELECT id, title FROM digest_items
         WHERE published_at > $1
         ORDER BY published_at ASC
         LIMIT 1`,
        [digest.published_at]
      );

      const { rows: nextRows } = await query<{ id: string; title: string }>(
        `SELECT id, title FROM digest_items
         WHERE published_at < $1
         ORDER BY published_at DESC
         LIMIT 1`,
        [digest.published_at]
      );

      const prevDigest = prevRows[0] || null;
      const nextDigest = nextRows[0] || null;

      const html = buildDigestPageHtml(
        digest.source,
        escapeHtml(digest.title),
        new Date(digest.published_at),
        content,
        prevDigest,
        nextDigest
      );
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error('Error fetching digest:', err);
      res.status(500).send('Error loading digest');
    }
  });

  return router;
}

interface DigestNav {
  id: string;
  title: string;
}

/**
 * Build the full interactive digest page HTML.
 * Features: dark theme, inline YouTube iframes, vim keyboard navigation (j/k/o/gg/G),
 * responsive images, and post-level focus management.
 */
function buildDigestPageHtml(
  source: string,
  title: string,
  publishedAt: Date,
  content: string,
  prevDigest: DigestNav | null,
  nextDigest: DigestNav | null
): string {
  const prevLink = prevDigest
    ? `<a href="/digest/${prevDigest.id}" class="nav-arrow prev" title="${escapeHtml(prevDigest.title)}">← Newer</a>`
    : '<span class="nav-arrow disabled">← Newer</span>';
  const nextLink = nextDigest
    ? `<a href="/digest/${nextDigest.id}" class="nav-arrow next" title="${escapeHtml(nextDigest.title)}">Older →</a>`
    : '<span class="nav-arrow disabled">Older →</span>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Slowfeed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #1a1a2e;
      --bg-card: #16213e;
      --border: #2a2a4a;
      --text: #eaeaea;
      --text-muted: #a0a0a0;
      --accent: #e94560;
      --link: #6db3f2;
      --focus-ring: #e94560;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      background: var(--bg);
      color: var(--text);
      padding: 0;
    }

    header {
      max-width: 900px;
      margin: 0 auto;
      padding: 24px 20px 16px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 100;
    }

    header h1 {
      font-size: 1.25rem;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .meta {
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    .nav-hint {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 6px;
    }

    .nav-hint kbd {
      display: inline-block;
      padding: 1px 5px;
      font-size: 0.6875rem;
      font-family: monospace;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 3px;
      margin: 0 1px;
    }

    .post-counter {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-left: auto;
      flex-shrink: 0;
    }

    .digest-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }

    .nav-arrow {
      font-size: 0.875rem;
      color: var(--link);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 4px;
      transition: background 0.2s;
    }

    .nav-arrow:hover {
      background: var(--bg-card);
      text-decoration: underline;
    }

    .nav-arrow.disabled {
      color: var(--text-muted);
      opacity: 0.5;
      cursor: default;
    }

    .nav-arrow.disabled:hover {
      background: none;
      text-decoration: none;
    }

    .source-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.6875rem;
      font-weight: bold;
      text-transform: uppercase;
      color: white;
      flex-shrink: 0;
    }
    .source-badge.reddit { background: #ff4500; }
    .source-badge.bluesky { background: #0085ff; }
    .source-badge.youtube { background: #ff0000; }
    .source-badge.discord { background: #5865f2; }

    .content {
      max-width: 900px;
      margin: 0 auto;
      padding: 0 20px 80px;
    }

    /* Article/post styling */
    article.post {
      background: var(--bg-card);
      border: 2px solid transparent;
      border-radius: 10px;
      padding: 20px;
      margin: 16px 0;
      transition: border-color 0.15s ease;
      scroll-margin-top: 100px;
    }

    article.post.focused {
      border-color: var(--focus-ring);
    }

    article.post h3 {
      margin: 8px 0;
      font-size: 1.125rem;
    }

    article.post h3 a {
      color: var(--text);
      text-decoration: none;
    }

    article.post h3 a:hover {
      color: var(--accent);
    }

    article.post p {
      margin-bottom: 10px;
    }

    article.post small {
      color: var(--text-muted);
    }

    /* Author line with avatar */
    .post-author {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    img.avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }

    article.post a {
      color: var(--link);
      text-decoration: none;
    }

    article.post a:hover {
      text-decoration: underline;
    }

    /* Images */
    article.post img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 8px 0;
    }

    /* YouTube embeds */
    .youtube-embed {
      position: relative;
      width: 100%;
      max-width: 720px;
      margin: 12px 0;
    }

    .youtube-embed iframe {
      width: 100%;
      aspect-ratio: 16 / 9;
      border: none;
      border-radius: 6px;
    }

    .youtube-embed img {
      cursor: pointer;
    }

    /* Reddit video/media */
    article.post video {
      max-width: 100%;
      border-radius: 6px;
    }

    /* Bluesky thread nesting */
    article.post.thread {
      border-left: 3px solid var(--link);
    }

    /* Blockquotes (Bluesky quote posts) */
    article.post blockquote {
      border-left: 3px solid var(--border);
      padding: 8px 12px;
      margin: 8px 0;
      color: var(--text-muted);
      background: rgba(255,255,255,0.03);
      border-radius: 0 6px 6px 0;
    }

    /* Comment sections */
    article.post h4 {
      margin: 12px 0 8px;
      font-size: 0.9375rem;
      color: var(--text-muted);
    }

    /* Horizontal rules within content (not between posts) */
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 16px 0;
    }

    /* Non-article content (summary line, section headers) */
    .content > p {
      padding: 12px 0;
      color: var(--text-muted);
    }

    .content > h2 {
      padding: 16px 0 8px;
      font-size: 1.25rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    footer {
      max-width: 900px;
      margin: 0 auto;
      padding: 16px 20px;
      border-top: 1px solid var(--border);
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    footer a { color: var(--link); }

    /* Mobile */
    @media (max-width: 600px) {
      header { padding: 16px 12px 12px; }
      header h1 { font-size: 1.0625rem; }
      .content { padding: 0 12px 60px; }
      article.post { padding: 14px; margin: 10px 0; }
      .nav-hint { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>
      <span class="source-badge ${source}">${source}</span>
      ${title}
      <span class="post-counter" id="post-counter"></span>
    </h1>
    <p class="meta">${publishedAt.toISOString().replace('T', ' ').substring(0, 19)} UTC</p>
    <div class="digest-nav">
      ${prevLink}
      <p class="nav-hint">
        <kbd>j</kbd>/<kbd>k</kbd> navigate
        <kbd>o</kbd> open
        <kbd>gg</kbd> top
        <kbd>G</kbd> bottom
      </p>
      ${nextLink}
    </div>
  </header>

  <div class="content" id="digest-content">
    ${content}
  </div>

  <footer>
    <p>Powered by <a href="/">Slowfeed</a></p>
  </footer>

  <script>
  (function() {
    // --- YouTube: replace thumbnail placeholders with iframes ---
    document.querySelectorAll('.youtube-embed[data-video-id]').forEach(function(el) {
      var videoId = el.getAttribute('data-video-id');
      el.innerHTML = '<iframe src="https://www.youtube.com/embed/' + videoId +
        '?rel=0" allowfullscreen loading="lazy"></iframe>';
    });

    // --- Reddit: convert reddit video links to embedded players ---
    document.querySelectorAll('article.post[data-source="reddit"] a[href*="v.redd.it"]').forEach(function(a) {
      // The parent reddit post URL is on the article
      var article = a.closest('article.post');
      if (!article) return;
      var redditUrl = article.getAttribute('data-url');
      if (redditUrl) {
        var container = document.createElement('div');
        container.className = 'youtube-embed';
        container.innerHTML = '<iframe src="https://www.redditmedia.com/mediaembed/lq?responsive=true&is_hierarchical=false" ' +
          'sandbox="allow-scripts allow-same-origin allow-popups" allowfullscreen loading="lazy"></iframe>';
        // Fallback: just leave the link if embed doesn't work
      }
    });

    // --- Vim-style keyboard navigation ---
    var posts = Array.from(document.querySelectorAll('article.post'));
    var currentIndex = -1;
    var gPending = false;

    function updateCounter() {
      var counter = document.getElementById('post-counter');
      if (counter && posts.length > 0) {
        counter.textContent = (currentIndex + 1) + '/' + posts.length;
      }
    }

    function focusPost(index) {
      if (index < 0 || index >= posts.length) return;

      // Remove previous focus
      if (currentIndex >= 0 && currentIndex < posts.length) {
        posts[currentIndex].classList.remove('focused');
      }

      currentIndex = index;
      posts[currentIndex].classList.add('focused');
      posts[currentIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
      updateCounter();
    }

    updateCounter();

    document.addEventListener('keydown', function(e) {
      // Don't capture if user is in an input/textarea
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      var key = e.key;

      // Handle 'gg' sequence
      if (gPending) {
        gPending = false;
        if (key === 'g') {
          e.preventDefault();
          focusPost(0);
          return;
        }
      }

      switch (key) {
        case 'j':
          e.preventDefault();
          focusPost(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, posts.length - 1));
          break;

        case 'k':
          e.preventDefault();
          if (currentIndex > 0) focusPost(currentIndex - 1);
          break;

        case 'o':
        case 'Enter':
          e.preventDefault();
          if (currentIndex >= 0 && currentIndex < posts.length) {
            var url = posts[currentIndex].getAttribute('data-url');
            if (url) window.open(url, '_blank');
          }
          break;

        case 'G':
          e.preventDefault();
          focusPost(posts.length - 1);
          break;

        case 'g':
          gPending = true;
          setTimeout(function() { gPending = false; }, 500);
          break;
      }
    });

    // Also allow click-to-focus
    posts.forEach(function(post, idx) {
      post.addEventListener('click', function(e) {
        // Don't steal clicks on links
        if (e.target.tagName === 'A' || e.target.closest('a')) return;
        focusPost(idx);
      });
    });
  })();
  </script>
</body>
</html>`;
}

// Helper to escape HTML in template
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
