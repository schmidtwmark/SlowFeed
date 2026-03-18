import crypto from 'crypto';
import { query } from './db.js';
import { logger } from './logger.js';

export interface FeedItemInput {
  source: string;
  postId: string;
  title: string;
  content: string | null;
  url: string;
  author: string | null;
  publishedAt: Date;
  isNotification?: boolean;
  rawJson?: unknown;
}

export function generateId(source: string, postId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}:${postId}`)
    .digest('hex');
}

export async function isDuplicate(source: string, postId: string): Promise<boolean> {
  const id = generateId(source, postId);
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM seen_posts WHERE id = $1',
    [id]
  );
  return rows.length > 0;
}

export async function addFeedItem(item: FeedItemInput): Promise<boolean> {
  const id = generateId(item.source, item.postId);

  // Check if already seen
  if (await isDuplicate(item.source, item.postId)) {
    logger.debug(`Skipping duplicate: ${item.source}:${item.postId}`);
    return false;
  }

  // Insert into seen_posts
  await query(
    `INSERT INTO seen_posts (id, source, post_id, title, added_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, item.source, item.postId, item.title]
  );

  // Insert into feed_items
  await query(
    `INSERT INTO feed_items (id, source, title, content, url, author, published_at, is_notification, raw_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      item.source,
      item.title,
      item.content,
      item.url,
      item.author,
      item.publishedAt,
      item.isNotification ?? false,
      item.rawJson ? JSON.stringify(item.rawJson) : null,
    ]
  );

  logger.info(`Added feed item: ${item.source}:${item.postId} - ${item.title}`);
  return true;
}

export async function pruneOldItems(ttlDays: number): Promise<number> {
  const result = await query(
    `DELETE FROM feed_items
     WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [ttlDays]
  );

  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) {
    logger.info(`Pruned ${deletedCount} old feed items`);
  }
  return deletedCount;
}
