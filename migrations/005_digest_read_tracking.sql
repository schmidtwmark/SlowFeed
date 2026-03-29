-- Add read tracking to digest_items
ALTER TABLE digest_items ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

-- Index for efficient read/unread queries
CREATE INDEX IF NOT EXISTS idx_digest_items_read_at ON digest_items(read_at);
CREATE INDEX IF NOT EXISTS idx_digest_items_source_published ON digest_items(source, published_at DESC);
