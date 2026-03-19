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
      const simple = req.query.simple === 'true';

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
      let content = digest.content || '';

      // Optionally simplify HTML
      if (simple) {
        content = content
          // Add separator before each post div
          .replace(/<div style="border:[^"]*padding:[^"]*>/gi, '<hr style="border:none;border-top:2px solid #ddd;margin:24px 0;"><div>')
          // Convert YouTube iframes to links
          .replace(/<iframe[^>]*src="https:\/\/www\.youtube\.com\/embed\/([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi,
            '<p><a href="https://www.youtube.com/watch?v=$1">▶ Watch on YouTube</a></p>')
          // Remove inline styles
          .replace(/\s*style="[^"]*"/gi, '')
          // Remove leading separator
          .replace(/^(\s*<[^>]*>\s*)*<hr[^>]*>/i, '');
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(digest.title)} - Slowfeed</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
      color: #333;
    }
    header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #ddd;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 8px;
    }
    .meta {
      color: #666;
      font-size: 0.875rem;
    }
    .source-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: bold;
      text-transform: uppercase;
      color: white;
      margin-right: 8px;
    }
    .source-badge.reddit { background: #ff4500; }
    .source-badge.bluesky { background: #0085ff; }
    .source-badge.youtube { background: #ff0000; }
    .source-badge.discord { background: #5865f2; }
    .content {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .content img {
      max-width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .content a {
      color: #0066cc;
    }
    .content h2, .content h3 {
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .content p {
      margin-bottom: 12px;
    }
    hr {
      border: none;
      border-top: 2px solid #ddd;
      margin: 24px 0;
    }
    footer {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid #ddd;
      font-size: 0.875rem;
      color: #666;
    }
    footer a {
      color: #0066cc;
    }
  </style>
</head>
<body>
  <header>
    <h1><span class="source-badge ${digest.source}">${digest.source}</span>${escapeHtml(digest.title)}</h1>
    <p class="meta">${new Date(digest.published_at).toLocaleString()}</p>
  </header>
  <div class="content">
    ${content}
  </div>
  <footer>
    <p>Powered by <a href="/">Slowfeed</a></p>
  </footer>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      logger.error('Error fetching digest:', err);
      res.status(500).send('Error loading digest');
    }
  });

  return router;
}

// Helper to escape HTML in template
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
