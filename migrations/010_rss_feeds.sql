-- Migration: RSS feeds — list of subscribed feed URLs polled by the RSS source.
--
-- Unlike the other sources (Reddit/Bluesky/etc.) where the user has at most
-- one set of credentials, RSS users typically subscribe to many feeds. We
-- store them in their own table; `last_fetched_at` lets the poll skip items
-- already seen at the per-feed level (a coarser dedup that runs before the
-- global `seen_posts` check).

CREATE TABLE IF NOT EXISTS rss_feeds (
    id              SERIAL PRIMARY KEY,
    feed_url        TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    site_url        TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    last_fetched_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rss_feeds_enabled_idx ON rss_feeds (enabled);
