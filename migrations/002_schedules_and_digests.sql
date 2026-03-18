-- Migration: Add poll schedules and digest items for consolidated feed output

-- Schedule-based polling configuration
CREATE TABLE poll_schedules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  days_of_week INTEGER[] NOT NULL,        -- 0=Sun, 1=Mon, ..., 6=Sat
  time_of_day TIME NOT NULL,              -- e.g., '07:00:00'
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  sources TEXT[] NOT NULL,                -- ['reddit', 'bluesky', 'youtube', 'discord']
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_poll_schedules_enabled ON poll_schedules(enabled);

-- Consolidated digest items (replaces individual feed_items for output)
CREATE TABLE digest_items (
  id TEXT PRIMARY KEY,                    -- e.g., 'reddit_1710172800000'
  source TEXT NOT NULL,
  schedule_id INTEGER REFERENCES poll_schedules(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,                  -- HTML with all posts
  post_count INTEGER NOT NULL,
  post_ids TEXT[] NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digest_items_source ON digest_items(source);
CREATE INDEX idx_digest_items_published_at ON digest_items(published_at DESC);
CREATE INDEX idx_digest_items_created_at ON digest_items(created_at);
CREATE INDEX idx_digest_items_schedule_id ON digest_items(schedule_id);

-- Link seen_posts to digests for tracking
ALTER TABLE seen_posts ADD COLUMN IF NOT EXISTS digest_id TEXT;
CREATE INDEX IF NOT EXISTS idx_seen_posts_digest_id ON seen_posts(digest_id);

-- Add default timezone to config
INSERT INTO config (key, value) VALUES
  ('default_timezone', '"America/Los_Angeles"')
ON CONFLICT (key) DO NOTHING;

-- Remove old interval-based config (keep for backwards compatibility during transition)
-- DELETE FROM config WHERE key = 'poll_interval_hours';
-- DELETE FROM config WHERE key = 'notification_interval_minutes';

-- Insert a default schedule (weekday mornings)
INSERT INTO poll_schedules (name, days_of_week, time_of_day, timezone, sources, enabled)
VALUES (
  'Weekday Morning',
  ARRAY[1, 2, 3, 4, 5],
  '07:00:00',
  'America/Los_Angeles',
  ARRAY['reddit', 'bluesky', 'youtube', 'discord'],
  TRUE
);
