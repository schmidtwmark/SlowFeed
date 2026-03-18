import crypto from 'crypto';
import { query } from './db.js';

export interface Config {
  /** @deprecated Use poll_schedules table instead */
  poll_interval_hours: number;
  bluesky_enabled: boolean;
  bluesky_handle: string;
  bluesky_app_password: string;
  bluesky_top_n: number;
  youtube_enabled: boolean;
  youtube_cookies: string;
  reddit_enabled: boolean;
  reddit_cookies: string;
  reddit_top_n: number;
  reddit_include_comments: boolean;
  reddit_comment_depth: number;
  discord_enabled: boolean;
  discord_token: string;
  discord_channels: string;
  discord_top_n: number;
  feed_title: string;
  feed_ttl_days: number;
  feed_token: string;
  ui_password: string;
}

// Generate a random token for feed access
export function generateFeedToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

const DEFAULT_CONFIG: Config = {
  poll_interval_hours: 4,
  bluesky_enabled: false,
  bluesky_handle: '',
  bluesky_app_password: '',
  bluesky_top_n: 20,
  youtube_enabled: false,
  youtube_cookies: '',
  reddit_enabled: false,
  reddit_cookies: '',
  reddit_top_n: 30,
  reddit_include_comments: true,
  reddit_comment_depth: 3,
  discord_enabled: false,
  discord_token: '',
  discord_channels: '[]',
  discord_top_n: 20,
  feed_title: 'Slowfeed',
  feed_ttl_days: 14,
  feed_token: generateFeedToken(),
  ui_password: 'changeme',
};

let cachedConfig: Config | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // Cache config for 60 seconds

export async function loadConfig(forceReload = false): Promise<Config> {
  // Return cached config if valid and not forcing reload
  if (!forceReload && cachedConfig && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedConfig;
  }

  const { rows } = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM config'
  );

  const config: Config = { ...DEFAULT_CONFIG };
  const existingKeys = new Set<string>();

  for (const row of rows) {
    existingKeys.add(row.key);
    if (row.key in config) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)[row.key] = row.value;
    }
  }

  // Persist feed_token if not already in DB (so it survives restarts)
  if (!existingKeys.has('feed_token')) {
    await query(
      `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING`,
      ['feed_token', JSON.stringify(config.feed_token)]
    );
  }

  cachedConfig = config;
  cacheTimestamp = Date.now();
  return config;
}

export function getConfig(): Config {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

export async function setConfigValue<K extends keyof Config>(
  key: K,
  value: Config[K]
): Promise<void> {
  await query(
    `INSERT INTO config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );

  // Invalidate cache
  cachedConfig = null;
  cacheTimestamp = 0;
}

export async function setConfigValues(
  values: Partial<Config>
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await setConfigValue(key as keyof Config, value as Config[keyof Config]);
  }
}

export async function getConfigValue<K extends keyof Config>(
  key: K
): Promise<Config[K]> {
  const { rows } = await query<{ value: Config[K] }>(
    'SELECT value FROM config WHERE key = $1',
    [key]
  );

  if (rows.length === 0) {
    return DEFAULT_CONFIG[key];
  }

  return rows[0].value;
}
