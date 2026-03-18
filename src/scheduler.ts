import cron from 'node-cron';
import { getConfig, loadConfig } from './config.js';
import { pruneOldItems } from './dedup.js';
import { logger } from './logger.js';
import { pollReddit } from './sources/reddit.js';
import { pollBluesky } from './sources/bluesky.js';
import { pollYouTube } from './sources/youtube.js';
import { pollDiscord } from './sources/discord.js';
import { pollRedditNotifications } from './notifications/reddit-mail.js';
import { pollBlueskyNotifications } from './notifications/bluesky-replies.js';
import { getEnabledSchedules, scheduleToCron } from './schedules.js';
import { filterNewPosts, createDigest, pruneOldDigests } from './digest.js';
import type { PollSchedule, SourceType, DigestPost } from './types/index.js';

// Map of schedule ID to cron job
const scheduleJobs: Map<number, cron.ScheduledTask> = new Map();
let pruneJob: cron.ScheduledTask | null = null;

// Track poll status for the UI
interface PollStatus {
  source: string;
  lastPoll: Date | null;
  lastError: string | null;
  isPolling: boolean;
}

// Track schedule status
interface ScheduleStatus {
  scheduleId: number;
  scheduleName: string;
  lastRun: Date | null;
  nextRun: Date | null;
  isRunning: boolean;
}

const pollStatus: Map<string, PollStatus> = new Map([
  ['reddit', { source: 'reddit', lastPoll: null, lastError: null, isPolling: false }],
  ['bluesky', { source: 'bluesky', lastPoll: null, lastError: null, isPolling: false }],
  ['youtube', { source: 'youtube', lastPoll: null, lastError: null, isPolling: false }],
  ['discord', { source: 'discord', lastPoll: null, lastError: null, isPolling: false }],
]);

const scheduleStatus: Map<number, ScheduleStatus> = new Map();

export function getPollStatus(): Map<string, PollStatus> {
  return pollStatus;
}

export function getScheduleStatus(): Map<number, ScheduleStatus> {
  return scheduleStatus;
}

// Get poll function for a source type
function getSourcePollFn(source: SourceType): () => Promise<DigestPost[]> {
  switch (source) {
    case 'reddit':
      return pollReddit;
    case 'bluesky':
      return pollBluesky;
    case 'youtube':
      return pollYouTube;
    case 'discord':
      return pollDiscord;
  }
}

// Get notification poll function for a source type
function getNotificationPollFn(source: SourceType): (() => Promise<DigestPost[]>) | null {
  switch (source) {
    case 'reddit':
      return pollRedditNotifications;
    case 'bluesky':
      return pollBlueskyNotifications;
    default:
      return null;
  }
}

// Run a scheduled poll for specific sources
async function runScheduledPoll(schedule: PollSchedule): Promise<void> {
  const status = scheduleStatus.get(schedule.id);
  if (status) {
    status.isRunning = true;
  }

  logger.info(`Running scheduled poll "${schedule.name}" for sources: ${schedule.sources.join(', ')}`);

  try {
    // Poll each source in the schedule
    for (const source of schedule.sources) {
      const sourceStatus = pollStatus.get(source);
      if (sourceStatus) {
        sourceStatus.isPolling = true;
      }

      try {
        // Get content posts
        const pollFn = getSourcePollFn(source);
        const posts = await pollFn();

        // Get notifications for this source (if available)
        const notificationFn = getNotificationPollFn(source);
        let notifications: DigestPost[] = [];
        if (notificationFn) {
          notifications = await notificationFn();
        }

        // Combine posts and notifications
        const allPosts = [...posts, ...notifications];

        // Filter to only new posts
        const newPosts = await filterNewPosts(allPosts, source);

        // Create digest if there are new posts
        // Pass undefined for schedule.id if it's 0 (dummy/initial poll)
        if (newPosts.length > 0) {
          await createDigest(source, newPosts, schedule.id > 0 ? schedule.id : undefined);
          logger.info(`Created ${source} digest with ${newPosts.length} items`);
        } else {
          logger.info(`No new posts for ${source}`);
        }

        if (sourceStatus) {
          sourceStatus.lastPoll = new Date();
          sourceStatus.lastError = null;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (sourceStatus) {
          sourceStatus.lastError = errorMessage;
        }
        logger.error(`${source} poll failed:`, err);
      } finally {
        if (sourceStatus) {
          sourceStatus.isPolling = false;
        }
      }
    }

    if (status) {
      status.lastRun = new Date();
    }

    logger.info(`Scheduled poll "${schedule.name}" completed`);
  } finally {
    if (status) {
      status.isRunning = false;
    }
  }
}

// Run prune jobs
async function runPrune(): Promise<void> {
  const config = getConfig();
  await pruneOldItems(config.feed_ttl_days);
  await pruneOldDigests(config.feed_ttl_days);
}

export async function startScheduler(): Promise<void> {
  // Stop any existing jobs first
  stopScheduler();

  // Load enabled schedules from database
  const schedules = await getEnabledSchedules();

  if (schedules.length === 0) {
    logger.info('No schedules configured - polling will not run automatically');
    logger.info('Create a schedule in the UI to enable automatic polling');
  }

  // Create a cron job for each schedule
  for (const schedule of schedules) {
    const cronExpr = scheduleToCron(schedule);

    // Create schedule status entry
    scheduleStatus.set(schedule.id, {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      lastRun: null,
      nextRun: null, // Will be calculated on demand
      isRunning: false,
    });

    // Create the cron job with timezone support
    const job = cron.schedule(
      cronExpr,
      () => {
        runScheduledPoll(schedule);
      },
      {
        timezone: schedule.timezone,
      }
    );

    scheduleJobs.set(schedule.id, job);
    logger.info(`Schedule "${schedule.name}" registered: ${cronExpr} (${schedule.timezone})`);
  }

  // Prune old items: daily at 3 AM
  pruneJob = cron.schedule('0 3 * * *', () => {
    runPrune();
  });
  logger.info('Prune job scheduled: daily at 3 AM');

  // Run initial poll for all sources if there are schedules
  // Skip if SKIP_INITIAL_POLL is set (useful for development)
  if (schedules.length > 0 && !process.env.SKIP_INITIAL_POLL) {
    logger.info('Running initial poll on startup...');
    // Collect all unique sources from all schedules
    const allSources = new Set<SourceType>();
    for (const schedule of schedules) {
      for (const source of schedule.sources) {
        allSources.add(source);
      }
    }
    // Run poll for each unique source (use first schedule as reference)
    const dummySchedule: PollSchedule = {
      id: 0,
      name: 'Initial Poll',
      days_of_week: [],
      time_of_day: '00:00',
      timezone: 'UTC',
      sources: Array.from(allSources),
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    await runScheduledPoll(dummySchedule);
  } else if (process.env.SKIP_INITIAL_POLL) {
    logger.info('Skipping initial poll (SKIP_INITIAL_POLL is set)');
  }
}

export function stopScheduler(): void {
  // Stop all schedule jobs
  for (const [id, job] of scheduleJobs) {
    job.stop();
    scheduleStatus.delete(id);
  }
  scheduleJobs.clear();

  // Stop prune job
  if (pruneJob) {
    pruneJob.stop();
    pruneJob = null;
  }

  logger.info('Scheduler stopped');
}

export async function restartScheduler(): Promise<void> {
  stopScheduler();
  await loadConfig();
  await startScheduler();
}

// Manual trigger: run a specific schedule
export async function triggerSchedulePoll(scheduleId: number): Promise<void> {
  const schedules = await getEnabledSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);

  if (!schedule) {
    throw new Error(`Schedule ${scheduleId} not found`);
  }

  logger.info(`Manual poll triggered for schedule: ${schedule.name}`);
  await runScheduledPoll(schedule);
}

// Manual trigger: poll a single source (creates a digest)
export async function triggerSourcePoll(source: SourceType): Promise<void> {
  logger.info(`Manual poll triggered for: ${source}`);

  const sourceStatus = pollStatus.get(source);
  if (sourceStatus) {
    sourceStatus.isPolling = true;
  }

  try {
    // Get content posts
    const pollFn = getSourcePollFn(source);
    const posts = await pollFn();

    // Get notifications for this source (if available)
    const notificationFn = getNotificationPollFn(source);
    let notifications: DigestPost[] = [];
    if (notificationFn) {
      notifications = await notificationFn();
    }

    // Combine posts and notifications
    const allPosts = [...posts, ...notifications];

    // Filter to only new posts
    const newPosts = await filterNewPosts(allPosts, source);

    // Create digest if there are new posts
    if (newPosts.length > 0) {
      await createDigest(source, newPosts);
      logger.info(`Created ${source} digest with ${newPosts.length} items`);
    } else {
      logger.info(`No new posts for ${source}`);
    }

    if (sourceStatus) {
      sourceStatus.lastPoll = new Date();
      sourceStatus.lastError = null;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (sourceStatus) {
      sourceStatus.lastError = errorMessage;
    }
    logger.error(`${source} poll failed:`, err);
    throw err;
  } finally {
    if (sourceStatus) {
      sourceStatus.isPolling = false;
    }
  }
}

// Manual trigger: poll all enabled sources
export async function triggerMainPoll(): Promise<void> {
  logger.info('Manual poll triggered for all sources');

  const config = getConfig();
  const sources: SourceType[] = [];

  if (config.reddit_enabled) sources.push('reddit');
  if (config.bluesky_enabled) sources.push('bluesky');
  if (config.youtube_enabled) sources.push('youtube');
  if (config.discord_enabled) sources.push('discord');

  // Poll each source
  for (const source of sources) {
    await triggerSourcePoll(source);
  }

  logger.info('Manual poll completed');
}
