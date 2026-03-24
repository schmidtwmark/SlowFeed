// Source types
export type SourceType = 'reddit' | 'bluesky' | 'youtube' | 'discord';

// Schedule types
export interface PollSchedule {
  id: number;
  name: string;
  days_of_week: number[];  // 0=Sun, 1=Mon, ..., 6=Sat
  time_of_day: string;     // HH:MM:SS format
  timezone: string;
  sources: SourceType[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduleInput {
  name: string;
  days_of_week: number[];
  time_of_day: string;
  timezone: string;
  sources: SourceType[];
  enabled?: boolean;
}

// Poll run types - track individual scheduled refreshes
export interface PollRun {
  id: number;
  schedule_id: number | null;
  schedule_name: string | null;
  sources: SourceType[];
  started_at: Date;
  completed_at: Date | null;
  status: 'running' | 'completed' | 'failed';
}

export interface PollRunRow {
  id: number;
  schedule_id: number | null;
  schedule_name: string | null;
  sources: string[];
  started_at: Date;
  completed_at: Date | null;
  status: string;
}

// Digest types
export interface DigestPost {
  postId: string;
  title: string;
  content: string;
  url: string;
  author: string | null;
  publishedAt: Date;
  isNotification?: boolean;
  rawJson?: unknown;
  // Source-specific metadata
  metadata?: {
    avatarUrl?: string;            // User/channel avatar URL
    score?: number;
    subreddit?: string;
    comments?: number;
    thumbnail?: string;
    channel?: string;
    duration?: string;
    guildName?: string;
    channelName?: string;
    // Discord-specific
    replyToMessageId?: string; // Discord message ID this replies to
    // Bluesky-specific
    repostedBy?: string;       // handle of person who reposted
    rootUri?: string;          // AT URI of thread root (for reply grouping)
    parentUri?: string;        // AT URI of direct parent post
  };
}

export interface DigestItem {
  id: string;                    // e.g., 'reddit_1710172800000'
  source: SourceType;
  schedule_id: number | null;
  poll_run_id: number | null;
  title: string;
  content: string;               // HTML with all posts
  post_count: number;
  post_ids: string[];
  published_at: Date;
  created_at: Date;
}

export interface DigestItemInput {
  source: SourceType;
  scheduleId?: number;
  posts: DigestPost[];
}

// Database row types
export interface PollScheduleRow {
  id: number;
  name: string;
  days_of_week: number[];
  time_of_day: string;
  timezone: string;
  sources: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface DigestItemRow {
  id: string;
  source: string;
  schedule_id: number | null;
  poll_run_id: number | null;
  title: string;
  content: string;
  post_count: number;
  post_ids: string[];
  published_at: Date;
  created_at: Date;
}
