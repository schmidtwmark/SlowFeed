-- Cache of text extracted from post images, so search can match words that
-- only appear inside a picture (memes, screenshots, video poster frames).
--
-- Keyed by a hash of the image URL rather than the URL itself: CDN URLs
-- (Reddit preview, Bluesky blobs) run long and carry signed query strings,
-- which makes them awkward as a primary key.
--
-- `text` is '' when OCR ran successfully but found nothing readable — that is
-- a real answer worth caching, so we don't re-OCR a texture-only photo on
-- every poll. Hard failures are simply not written, so they retry later.
CREATE TABLE IF NOT EXISTS image_ocr (
  url_hash TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_ocr_created_at ON image_ocr(created_at);
