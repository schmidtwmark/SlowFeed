CREATE TABLE saved_posts (
  id TEXT PRIMARY KEY,                -- the post's postId (platform-native)
  source TEXT NOT NULL,               -- 'reddit', 'bluesky', 'youtube', 'discord'
  digest_id TEXT,                     -- which digest it came from (nullable)
  post_json JSONB NOT NULL,           -- full DigestPost object
  saved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_saved_posts_source ON saved_posts (source);
CREATE INDEX idx_saved_posts_saved_at ON saved_posts (saved_at DESC);
