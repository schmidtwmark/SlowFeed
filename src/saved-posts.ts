import { query } from './db.js';
import { logger } from './logger.js';
import type { DigestPost, SourceType } from './types/index.js';

export interface SavedPostGroup {
  source: SourceType;
  posts: (DigestPost & { savedAt: string })[];
}

export async function savePost(
  postId: string,
  source: SourceType,
  digestId: string | null,
  post: DigestPost
): Promise<boolean> {
  const result = await query(
    `INSERT INTO saved_posts (id, source, digest_id, post_json, saved_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [postId, source, digestId, JSON.stringify(post).replace(/\u0000/g, '')]
  );
  const inserted = (result.rowCount ?? 0) > 0;
  if (inserted) logger.info(`Saved post ${postId} (${source})`);
  return inserted;
}

export async function unsavePost(postId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM saved_posts WHERE id = $1`,
    [postId]
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) logger.info(`Unsaved post ${postId}`);
  return deleted;
}

export async function getSavedPosts(source?: SourceType): Promise<SavedPostGroup[]> {
  let sql = `SELECT id, source, post_json, saved_at FROM saved_posts`;
  const params: string[] = [];
  if (source) {
    sql += ` WHERE source = $1`;
    params.push(source);
  }
  sql += ` ORDER BY saved_at DESC`;

  const { rows } = await query<{ id: string; source: string; post_json: unknown; saved_at: Date }>(sql, params);

  // Group by source
  const groups = new Map<string, (DigestPost & { savedAt: string })[]>();
  for (const row of rows) {
    const post = (typeof row.post_json === 'string' ? JSON.parse(row.post_json) : row.post_json) as DigestPost;
    const entry = { ...post, savedAt: new Date(row.saved_at).toISOString() };
    const existing = groups.get(row.source) || [];
    existing.push(entry);
    groups.set(row.source, existing);
  }

  return Array.from(groups.entries()).map(([src, posts]) => ({
    source: src as SourceType,
    posts,
  }));
}

export async function getSavedPostIds(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM saved_posts`);
  return rows.map(r => r.id);
}
