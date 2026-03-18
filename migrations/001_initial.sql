-- Stores all config key/value pairs (JSON values)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deduplication: tracks every post ever added to the feed
CREATE TABLE seen_posts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_seen_posts_source ON seen_posts(source);
CREATE INDEX idx_seen_posts_added_at ON seen_posts(added_at);

-- The feed items themselves (kept for TTL-based expiry)
CREATE TABLE feed_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT NOT NULL,
  author TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  is_notification BOOLEAN DEFAULT FALSE,
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_feed_items_source ON feed_items(source);
CREATE INDEX idx_feed_items_published_at ON feed_items(published_at DESC);
CREATE INDEX idx_feed_items_is_notification ON feed_items(is_notification);
CREATE INDEX idx_feed_items_created_at ON feed_items(created_at);

-- OAuth tokens (encrypted at rest)
CREATE TABLE oauth_tokens (
  service TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default configuration values
INSERT INTO config (key, value) VALUES
  ('poll_interval_hours', '4'),
  ('notification_interval_minutes', '5'),
  ('bluesky_enabled', 'false'),
  ('bluesky_handle', '""'),
  ('bluesky_app_password', '""'),
  ('bluesky_top_n', '20'),
  ('youtube_enabled', 'false'),
  ('reddit_enabled', 'false'),
  ('reddit_top_n', '30'),
  ('reddit_include_comments', 'true'),
  ('reddit_comment_depth', '3'),
  ('feed_title', '"Slowfeed"'),
  ('feed_ttl_days', '14'),
  ('ui_password', '"changeme"');
