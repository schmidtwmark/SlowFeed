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

// ---- Structured post data (shared between server + native clients) ----

/** A media attachment (image, video, or file) */
export interface PostMedia {
  type: 'image' | 'video' | 'file';
  url: string;
  thumbnailUrl?: string;    // poster/preview for videos, thumb for files
  audioUrl?: string;        // separate audio track (Reddit DASH videos)
  alt?: string;
  filename?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

/** An external link card */
export interface PostLink {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

/** An embedded object (Discord embeds, quote posts) */
export interface PostEmbed {
  type: 'quote' | 'link_card';
  title?: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  author?: string;
  authorAvatarUrl?: string;
  text?: string;           // body text of quoted post
  provider?: string;       // e.g., 'Twitter', 'YouTube', 'Instagram', 'Bluesky'
  publishedAt?: string;    // ISO 8601 timestamp of the quoted/embedded post
}

/** Source-specific metadata */
export interface PostMetadata {
  // Common
  avatarUrl?: string;

  // Reddit
  score?: number;
  subreddit?: string;

  // YouTube
  videoId?: string;
  channel?: string;
  channelUrl?: string;
  duration?: string;
  viewCount?: string;
  publishedText?: string;

  // Discord
  guildName?: string;
  channelName?: string;
  replyToMessageId?: string;

  // Bluesky
  repostedBy?: string;
  rootUri?: string;
  parentUri?: string;
}

// Digest types
export interface DigestPost {
  postId: string;
  title: string;
  content: string;             // Plain text body (no HTML)
  url: string;
  author: string | null;
  publishedAt: Date;
  isNotification?: boolean;
  rawJson?: unknown;
  metadata?: PostMetadata;
  media?: PostMedia[];         // Images, videos, files
  links?: PostLink[];          // External link cards
  embeds?: PostEmbed[];        // Quoted posts, Discord embeds
  replies?: DigestPost[];      // Child posts in thread (Bluesky)
  quotedPost?: DigestPost;     // Inline quoted post (Bluesky)
}

export interface DigestItem {
  id: string;                    // e.g., 'reddit_1710172800000'
  source: SourceType;
  schedule_id: number | null;
  poll_run_id: number | null;
  title: string;
  content: string;               // Legacy HTML - generated on demand now
  post_count: number;
  post_ids: string[];
  posts_json: DigestPost[] | null;  // Structured post data
  published_at: Date;
  created_at: Date;
  read_at: Date | null;          // When the digest was marked as read
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
  posts_json: unknown;
  published_at: Date;
  created_at: Date;
  read_at: Date | null;
}
