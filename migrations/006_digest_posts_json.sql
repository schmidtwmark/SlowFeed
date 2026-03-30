-- Migration: Add posts_json column to digest_items to store structured post data
-- This ensures post data survives feed_items pruning

ALTER TABLE digest_items ADD COLUMN IF NOT EXISTS posts_json JSONB;

-- Backfill existing digests from feed_items where possible
UPDATE digest_items di
SET posts_json = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'postId', fi.id,
      'source', fi.source,
      'title', fi.title,
      'content', fi.content,
      'url', fi.url,
      'author', fi.author,
      'publishedAt', fi.published_at,
      'isNotification', fi.is_notification
    ) ORDER BY fi.published_at DESC
  )
  FROM seen_posts sp
  JOIN feed_items fi ON fi.id = sp.id
  WHERE sp.digest_id = di.id
)
WHERE di.posts_json IS NULL;
