-- Track how far through a digest the user has read (0.0–1.0), so the
-- sidebar can show partial-read progress instead of a binary
-- read/unread indicator. read_at now means "fully read" (reached the
-- end), set when read_progress reaches ~1.0, rather than "opened".
ALTER TABLE digest_items
  ADD COLUMN IF NOT EXISTS read_progress REAL NOT NULL DEFAULT 0;
