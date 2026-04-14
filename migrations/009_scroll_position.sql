-- Migration: Track last-read post position per digest for cross-device continuity

ALTER TABLE digest_items ADD COLUMN IF NOT EXISTS last_read_post_id TEXT;
