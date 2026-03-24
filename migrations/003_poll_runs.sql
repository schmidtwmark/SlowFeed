-- Migration: Add poll_runs table to track individual scheduled refreshes

-- Track each execution of a scheduled poll
CREATE TABLE poll_runs (
  id SERIAL PRIMARY KEY,
  schedule_id INTEGER REFERENCES poll_schedules(id) ON DELETE SET NULL,
  schedule_name TEXT,                       -- Store name at time of run (in case schedule is deleted)
  sources TEXT[] NOT NULL,                  -- Sources that were polled
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'    -- 'running', 'completed', 'failed'
);

CREATE INDEX idx_poll_runs_started_at ON poll_runs(started_at DESC);
CREATE INDEX idx_poll_runs_schedule_id ON poll_runs(schedule_id);

-- Add poll_run_id to digest_items to group digests by poll run
ALTER TABLE digest_items ADD COLUMN IF NOT EXISTS poll_run_id INTEGER REFERENCES poll_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_digest_items_poll_run_id ON digest_items(poll_run_id);
