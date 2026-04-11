import { Router, Request, Response, NextFunction } from 'express';
import { loadConfig, getConfig, setConfigValues, Config } from '../config.js';
import { query } from '../db.js';
import { triggerMainPoll, triggerSourcePoll, triggerSchedulePoll, restartScheduler, getPollStatus, getScheduleStatus } from '../scheduler.js';
import { getAllSchedules, createSchedule, updateSchedule, deleteSchedule, validateScheduleInput, getNextRunTime } from '../schedules.js';
import { testBlueskyConnection, pollBluesky } from '../sources/bluesky.js';
import { testDiscordConnection, fetchGuilds, fetchChannels, pollDiscord } from '../sources/discord.js';
import { pollReddit } from '../sources/reddit.js';
import { pollYouTube } from '../sources/youtube.js';
import { logger, getLogs, clearLogs } from '../logger.js';
import { getDigestItems, getDigestById, markDigestAsRead, markDigestAsUnread, getDigestPosts, stripHtml } from '../digest.js';
import { savePost, unsavePost, getSavedPosts, getSavedPostIds } from '../saved-posts.js';
import type { ScheduleInput, SourceType, DigestPost } from '../types/index.js';
import {
  hasPasskeys,
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  getCredentials,
  deleteCredential,
  renameCredential,
  getWebAuthnConfig,
} from '../webauthn.js';

// Simple session store (in production, use a proper session store)
const sessions = new Map<string, { authenticated: boolean; expires: number }>();

function generateSessionId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function getSessionId(req: Request): string | undefined {
  // Check header first (API calls from SPA)
  const headerSession = req.headers['x-session-id'] as string;
  if (headerSession) return headerSession;

  // Check cookie (server-rendered pages visited via browser navigation)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('slowfeed_session='));
    if (match) return match.split('=')[1];
  }

  return undefined;
}

function isValidSession(sessionId: string | undefined): boolean {
  if (!sessionId || !sessions.has(sessionId)) return false;
  const session = sessions.get(sessionId)!;
  if (session.authenticated && session.expires > Date.now()) return true;
  sessions.delete(sessionId);
  return false;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isValidSession(getSessionId(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

export function createApiRouter(): Router {
  const router = Router();

  // Apple App Site Association for passkey domain verification
  router.get('/.well-known/apple-app-site-association', (_req, res) => {
    const config = getWebAuthnConfig();
    // Team ID and bundle identifier for the iOS/macOS app
    const teamId = process.env.APPLE_TEAM_ID || 'C2UW47HS8X';
    const bundleId = process.env.APPLE_BUNDLE_ID || 'com.markschmidt.slowfeed-client';

    const association = {
      webcredentials: {
        apps: [`${teamId}.${bundleId}`]
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.json(association);
  });

  // Check if passkeys are set up (for first-time setup detection)
  router.get('/api/auth/setup-status', async (_req, res) => {
    try {
      const setupComplete = await hasPasskeys();
      res.json({ setupComplete });
    } catch (err) {
      logger.error('Error checking setup status:', err);
      res.status(500).json({ error: 'Failed to check setup status' });
    }
  });

  // Start passkey registration
  router.post('/api/auth/register/start', async (req, res) => {
    try {
      // If passkeys already exist, require authentication
      const passkeyExists = await hasPasskeys();
      if (passkeyExists) {
        if (!isValidSession(getSessionId(req))) {
          res.status(401).json({ error: 'Authentication required to add a new passkey' });
          return;
        }
      }

      const { options, challengeId } = await startRegistration();
      res.json({ options, challengeId });
    } catch (err) {
      logger.error('Error starting registration:', err);
      res.status(500).json({ error: 'Failed to start registration' });
    }
  });

  // Finish passkey registration
  router.post('/api/auth/register/finish', async (req, res) => {
    try {
      const { challengeId, response, name } = req.body;

      if (!challengeId || !response) {
        res.status(400).json({ error: 'Missing challengeId or response' });
        return;
      }

      // If passkeys already exist, require authentication
      const passkeyExists = await hasPasskeys();
      if (passkeyExists) {
        if (!isValidSession(getSessionId(req))) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
      }

      await finishRegistration(challengeId, response, name);

      // Create a session for the user
      const sessionId = generateSessionId();
      const expiresMs = 24 * 60 * 60 * 1000; // 24 hours
      sessions.set(sessionId, {
        authenticated: true,
        expires: Date.now() + expiresMs,
      });

      res.cookie('slowfeed_session', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: expiresMs,
        path: '/',
      });
      res.json({ success: true, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      logger.error('Registration error:', err);
      res.status(400).json({ error: message });
    }
  });

  // Start passkey authentication (login)
  router.post('/api/auth/login/start', async (_req, res) => {
    try {
      const passkeyExists = await hasPasskeys();
      if (!passkeyExists) {
        res.status(400).json({ error: 'No passkeys registered. Please set up a passkey first.' });
        return;
      }

      const { options, challengeId } = await startAuthentication();
      res.json({ options, challengeId });
    } catch (err) {
      logger.error('Error starting authentication:', err);
      res.status(500).json({ error: 'Failed to start authentication' });
    }
  });

  // Finish passkey authentication (login)
  router.post('/api/auth/login/finish', async (req, res) => {
    try {
      const { challengeId, response } = req.body;

      if (!challengeId || !response) {
        res.status(400).json({ error: 'Missing challengeId or response' });
        return;
      }

      await finishAuthentication(challengeId, response);

      // Create a session
      const sessionId = generateSessionId();
      const expiresMs = 24 * 60 * 60 * 1000; // 24 hours
      sessions.set(sessionId, {
        authenticated: true,
        expires: Date.now() + expiresMs,
      });

      res.cookie('slowfeed_session', sessionId, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: expiresMs,
        path: '/',
      });
      res.json({ success: true, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      logger.error('Authentication error:', err);
      res.status(401).json({ error: message });
    }
  });

  // Logout endpoint
  router.post('/api/logout', (req, res) => {
    const sid = getSessionId(req);
    if (sid) {
      sessions.delete(sid);
    }
    res.clearCookie('slowfeed_session', { path: '/' });
    res.json({ success: true });
  });

  // Check auth status
  router.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: isValidSession(getSessionId(req)) });
  });

  // Get WebAuthn configuration (for debugging)
  router.get('/api/auth/webauthn-config', (_req, res) => {
    res.json(getWebAuthnConfig());
  });

  // Protected routes below
  router.use('/api', authMiddleware);

  // Passkey management endpoints (protected)
  router.get('/api/passkeys', async (_req, res) => {
    try {
      const credentials = await getCredentials();
      // Return safe version without public keys
      const safeCredentials = credentials.map((cred) => ({
        id: cred.id,
        name: cred.name,
        deviceType: cred.deviceType,
        backedUp: cred.backedUp,
        createdAt: cred.createdAt,
        lastUsedAt: cred.lastUsedAt,
      }));
      res.json(safeCredentials);
    } catch (err) {
      logger.error('Error fetching passkeys:', err);
      res.status(500).json({ error: 'Failed to fetch passkeys' });
    }
  });

  router.delete('/api/passkeys/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await deleteCredential(id);
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Passkey not found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete passkey';
      logger.error('Error deleting passkey:', err);
      res.status(400).json({ error: message });
    }
  });

  router.patch('/api/passkeys/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'Name is required' });
        return;
      }
      const updated = await renameCredential(id, name);
      if (updated) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Passkey not found' });
      }
    } catch (err) {
      logger.error('Error renaming passkey:', err);
      res.status(500).json({ error: 'Failed to rename passkey' });
    }
  });

  // ========================================
  // Native App API Endpoints
  // ========================================

  // List all digests with optional source filter
  router.get('/api/digests', async (req, res) => {
    try {
      const source = req.query.source as SourceType | undefined;
      const digests = await getDigestItems(source);

      // Return without HTML content for listing (lighter payload)
      const digestList = digests.map(d => ({
        id: d.id,
        source: d.source,
        title: d.title,
        postCount: d.post_count,
        pollRunId: d.poll_run_id,
        publishedAt: d.published_at,
        readAt: d.read_at,
      }));

      res.json(digestList);
    } catch (err) {
      logger.error('Error fetching digests:', err);
      res.status(500).json({ error: 'Failed to fetch digests' });
    }
  });

  // Get single digest with structured post data
  router.get('/api/digests/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const digest = await getDigestById(id);

      if (!digest) {
        res.status(404).json({ error: 'Digest not found' });
        return;
      }

      const { content, posts_json, ...digestWithoutHtml } = digest;
      let posts: DigestPost[] = posts_json || [];

      // Fallback for digests created before posts_json was added
      if (posts.length === 0) {
        const minimalPosts = await getDigestPosts(id);
        posts = minimalPosts.map(p => ({
          postId: p.postId,
          title: p.title ?? 'Untitled',
          content: '',
          url: '',
          author: null,
          publishedAt: digest.published_at,
        }));
      }

      // Strip any residual HTML from post content (old digests may have HTML)
      posts = posts.map(p => ({
        ...p,
        content: p.content ? stripHtml(p.content) : p.content,
      }));

      res.json({
        ...digestWithoutHtml,
        posts,
      });
    } catch (err) {
      logger.error('Error fetching digest:', err);
      res.status(500).json({ error: 'Failed to fetch digest' });
    }
  });

  // Mark digest as read
  router.post('/api/digests/:id/read', async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await markDigestAsRead(id);

      if (updated) {
        res.json({ success: true });
      } else {
        // May already be read or not found - still return success
        res.json({ success: true, alreadyRead: true });
      }
    } catch (err) {
      logger.error('Error marking digest as read:', err);
      res.status(500).json({ error: 'Failed to mark digest as read' });
    }
  });

  // Mark digest as unread
  router.delete('/api/digests/:id/read', async (req, res) => {
    try {
      const { id } = req.params;
      await markDigestAsUnread(id);
      res.json({ success: true });
    } catch (err) {
      logger.error('Error marking digest as unread:', err);
      res.status(500).json({ error: 'Failed to mark digest as unread' });
    }
  });

  // Get available sources and their enabled status
  router.get('/api/sources', async (_req, res) => {
    try {
      const config = await loadConfig();
      const sources = [
        { id: 'reddit', name: 'Reddit', enabled: config.reddit_enabled },
        { id: 'bluesky', name: 'Bluesky', enabled: config.bluesky_enabled },
        { id: 'youtube', name: 'YouTube', enabled: config.youtube_enabled },
        { id: 'discord', name: 'Discord', enabled: config.discord_enabled },
      ];
      res.json(sources);
    } catch (err) {
      logger.error('Error fetching sources:', err);
      res.status(500).json({ error: 'Failed to fetch sources' });
    }
  });

  // Get configuration
  router.get('/api/config', async (_req, res) => {
    try {
      const config = await loadConfig();
      // Don't send secrets to the client (but keep feed_token visible)
      const safeConfig = {
        ...config,
        bluesky_app_password: config.bluesky_app_password ? '••••••••' : '',
        discord_token: config.discord_token ? '••••••••' : '',
        youtube_cookies: config.youtube_cookies ? '••••••••' : '',
        reddit_cookies: config.reddit_cookies ? '••••••••' : '',
      };
      // Remove legacy password field if present
      delete (safeConfig as Record<string, unknown>).ui_password;
      res.json(safeConfig);
    } catch (err) {
      logger.error('Error fetching config:', err);
      res.status(500).json({ error: 'Failed to fetch config' });
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
        'discord_enabled',
        'discord_token',
        'discord_channels',
        'discord_top_n',
        'feed_ttl_days',
        // ui_password removed - using passkeys for authentication now
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

  // --- Saved Posts ---

  router.get('/api/saved-posts', async (req, res) => {
    try {
      const source = req.query.source as SourceType | undefined;
      const groups = await getSavedPosts(source);
      res.json(groups);
    } catch (err) {
      logger.error('Error fetching saved posts:', err);
      res.status(500).json({ error: 'Failed to fetch saved posts' });
    }
  });

  router.get('/api/saved-posts/ids', async (_req, res) => {
    try {
      const ids = await getSavedPostIds();
      res.json({ ids });
    } catch (err) {
      logger.error('Error fetching saved post IDs:', err);
      res.status(500).json({ error: 'Failed to fetch saved post IDs' });
    }
  });

  router.post('/api/saved-posts', async (req, res) => {
    try {
      const { postId, source, digestId, post } = req.body;
      if (!postId || !source || !post) {
        res.status(400).json({ error: 'Missing required fields: postId, source, post' });
        return;
      }
      const inserted = await savePost(postId, source, digestId || null, post);
      if (!inserted) {
        res.status(409).json({ error: 'Post already saved' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('Error saving post:', err);
      res.status(500).json({ error: 'Failed to save post' });
    }
  });

  router.delete('/api/saved-posts/:postId', async (req, res) => {
    try {
      const deleted = await unsavePost(req.params.postId);
      if (!deleted) {
        res.status(404).json({ error: 'Saved post not found' });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('Error unsaving post:', err);
      res.status(500).json({ error: 'Failed to unsave post' });
    }
  });


  return router;
}
